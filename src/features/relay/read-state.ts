import { newer, type RelayEvent } from "./events";
import {
  markMessage,
  retainLocalRead,
  type CoveredFrontier,
} from "./read-state-retention";
import {
  READ_SNAPSHOT_BYTES,
  READ_SNAPSHOT_EVENTS,
  ReadStateTimestampRejected,
  type ReadStateHost,
} from "./read-state-host";
import {
  effectiveFrontier,
  EMPTY_READ_STATE,
  mergeReadStates,
  packReadState,
  parseReadBlob,
  readBlob,
  groupBlob,
  readCoordinate,
  readVersion,
  READ_RETENTION_SECONDS,
  READ_STATE_SLOTS,
  contextId,
  channelContext,
  channelGroups,
  changeOverride,
  overrideActive,
  uint32,
  type ReadState,
  type ParsedReadBlob,
} from "./read-state-model";
import {
  newReadJournal,
  newSlotId,
  type ReadJournal,
  type ReadStateStorage,
} from "./read-state-storage";
import {
  LARGE_READ_DEADLINE_MS,
  type Priority,
  type RelayReader,
} from "./reader";

export type ReadSyncSnapshot = Readonly<{
  capability: "unsupported" | "read-only" | "frontier-sync";
  status:
    | "loading"
    | "local"
    | "pending"
    | "accepted"
    | "reconciled"
    | "stale"
    | "error";
  /** Atomic marker enumeration only; says nothing about completeness of message history. */
  completeness: "unknown" | "snapshot" | "bounded";
  error?: string | undefined;
}>;
export type ReadMutationResult = Readonly<{
  operationId: string;
  durability: "saved";
  sync: "pending" | "local-only";
  /** Conditional device-local inverse; coverage depends on `undoScope`.
   * Untagged handles may restore saved reminders only. Later intent or lost
   * operation validity can expire the handle. */
  undo?: () => Promise<ReadMutationResult>;
  /** With `undo`, identifies exact captured-action receipt, reminder and
   * visit-overlay restoration. Absent on legacy saved-marker-only handles. */
  undoScope?: "captured-action";
}>;
export type ReadPublisherLock = (
  signal: AbortSignal,
  work: () => Promise<void>,
) => Promise<void>;
export function browserReadPublisherLock(
  scope: string,
): ReadPublisherLock | undefined {
  if (typeof navigator === "undefined" || !navigator.locks) return;
  return (signal, work) =>
    navigator.locks.request(
      `buzz-read-state:${scope}`,
      { mode: "exclusive", signal },
      work,
    );
}
const encoder = new TextEncoder();
const encodedBytes = (event: RelayEvent) =>
  encoder.encode(JSON.stringify(event)).byteLength;
const dTag = (event: RelayEvent) =>
  event.tags.find(([name]) => name === "d")?.[1] ?? "";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Read state unavailable";
/** The reader left before the save ran: the caller's intent, not sync health. */
class ObservationExpired extends Error {
  constructor() {
    super("Reading observation expired");
  }
}
export class CapturedReadWouldWidenError extends Error {
  constructor() {
    super("Exact captured read would widen the retained read set");
    this.name = "CapturedReadWouldWidenError";
  }
}
export class CapturedReadNotRetainedError extends Error {
  constructor() {
    super("Exact captured read could not retain every selected message");
    this.name = "CapturedReadNotRetainedError";
  }
}
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = Object.entries(a),
    right = Object.entries(b);
  return (
    left.length === right.length &&
    left.every(
      ([key, value]) =>
        Object.hasOwn(b, key) &&
        same(value, (b as Record<string, unknown>)[key]),
    )
  );
};
/** Reserve and journal are disjoint; only own values are published. */
const localState = (journal: ReadJournal): ReadState => {
  const frontiers: Record<string, number> = {
    ...journal.reserve,
    ...journal.state.frontiers,
  };
  for (const [key, value] of Object.entries(journal.own ?? {}))
    frontiers[key] = Math.max(frontiers[key] ?? 0, value);
  return Object.freeze({
    frontiers: Object.freeze(frontiers),
    overrides: journal.state.overrides,
  });
};
/** Which broader mark covers a mark, as in `CoveredFrontier`. `home` gives
 * the channel of a message when it is known: from a loaded message, or from
 * a channel saved with the mark. */
export type MarkCoverage = Readonly<{
  covered: (
    key: string,
    frontier: (key: string) => number | undefined,
    home: (id: string) => string | undefined,
  ) => string | undefined;
  /** The channel of a loaded, verified message. */
  home: (id: string) => string | undefined;
}>;
/** One durable domain owner. Read intent is not cache; one tab never saves over another's intent. */
export function createReadState({
  viewer,
  reader,
  host,
  storage,
  lock,
  notify = (listener) => listener(),
  now = () => Math.floor(Date.now() / 1000),
  debounceMs = 5000,
  broadcastName,
  floor = () => now() - READ_RETENTION_SECONDS,
}: {
  viewer: string;
  reader: RelayReader;
  host: ReadStateHost | undefined;
  storage: ReadStateStorage;
  lock?: ReadPublisherLock | undefined;
  notify?: (listener: () => void) => void;
  now?: () => number;
  debounceMs?: number;
  broadcastName?: string | undefined;
  /** Every message at or before this time counts as read. */
  floor?: (() => number) | undefined;
}) {
  let closed = false;
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  let journal: ReadJournal | undefined;
  let state: ReadState = EMPTY_READ_STATE;
  // Message evidence (and so ancestry) belongs to unread, which registers this.
  let coverage: MarkCoverage | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing: Promise<void> | undefined;
  let publishing: Promise<void> | undefined;
  // Loading a peer revision is not attempting it. Failed attempts wait for explicit retry.
  let attemptedRevision = -1;
  let failedRevision: number | undefined;
  let work: Promise<unknown> = Promise.resolve();
  let epoch = 0;
  let requested = false;
  /** The completeness the last drop interrupted, while nothing since has
   * failed: a continuous replay brings the markers back to it without a read. */
  let resumable: ReadSyncSnapshot["completeness"] | undefined;
  const slots = new Map<
    string,
    { event: RelayEvent; parsed: ParsedReadBlob }
  >();
  // Encoded size of each own kind-30078 coordinate in the last complete
  // snapshot, so a publication cannot make the next snapshot impossible.
  let snapshotSizes: Map<string, number> | undefined;
  const capability = !host
    ? "unsupported"
    : !host.sign || !host.publish || !lock
      ? "read-only"
      : "frontier-sync";
  let snapshot: ReadSyncSnapshot = Object.freeze({
    capability,
    status: "loading",
    completeness: "unknown",
  });
  const broadcast =
    broadcastName && typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(broadcastName)
      : undefined;
  const emit = () => {
    if (!closed) for (const listener of listeners) notify(listener);
  };
  /** A snapshot read failed, an accepted marker failed to apply, or the
   * stream dropped, and no snapshot read or resume has succeeded since. */
  let observationOwed = false;
  const health = (patch: Partial<ReadSyncSnapshot>) => {
    if (patch.status) failedRevision = undefined;
    if (patch.status === "error") resumable = undefined;
    const next = { ...snapshot, ...patch };
    if (!same(next, snapshot)) {
      snapshot = Object.freeze(next);
      emit();
    }
  };
  /**
   * Checked inside the storage transaction with the journal it will replace,
   * so a fence on local intent sees other windows' saves, not this cache.
   */
  type Validity = (current: ReadJournal) => boolean;
  type LocalUnreadUndo = {
    keys: ReadonlySet<string>;
    valid: () => boolean;
  };
  type CapturedReadUndo = {
    token: string;
    before: Pick<
      ReadJournal,
      "state" | "recent" | "reserve" | "homes" | "floor"
    >;
  };
  type LocalUnreadAttempt = {
    key: string;
    saved?: { revision: number; previous: number };
  };
  const pendingLocalUnread = new Set<LocalUnreadAttempt>();
  type LocalUnreadFence = Promise<{ valid: Validity } | { error: unknown }>;
  function captureLocalUnreadRevision() {
    return new Promise<ReadJournal | undefined>((resolve) =>
      resolve(storage.capture()),
    ).then(
      (captured) => ({ revision: captured?.revision ?? 0 }),
      (error: unknown) => ({ error }),
    );
  }
  function captureLocalUnread(
    keys: readonly string[],
    cut?: ReturnType<typeof captureLocalUnreadRevision>,
  ): LocalUnreadFence {
    // Reserve at the click, not when a channel's queue eventually runs. Older
    // queued local actions are allowed only after their save actually succeeds.
    const older = [...pendingLocalUnread].filter(({ key }) =>
      keys.includes(key),
    );
    return (cut ?? captureLocalUnreadRevision()).then((captured) => {
      if ("error" in captured) return captured;
      return {
        valid: (current: ReadJournal) =>
          keys.every((key) => {
            let revision = current.localUnread[key] ?? 0;
            // An older queued save may overwrite a newer window's mark. Only
            // follow successful older saves back to the captured journal cut.
            while (revision > captured.revision) {
              const saved = older.find(
                (attempt) =>
                  attempt.key === key && attempt.saved?.revision === revision,
              )?.saved;
              if (!saved) return false;
              revision = saved.previous;
            }
            return true;
          }),
      };
    });
  }
  async function capturedValidity(valid: Validity, fence: LocalUnreadFence) {
    const captured = await fence;
    if ("error" in captured) throw captured.error;
    return (current: ReadJournal) => valid(current) && captured.valid(current);
  }
  function queue<T>(job: () => Promise<T>): Promise<T> {
    const next = work.then(job);
    work = next.catch(() => {});
    return next;
  }
  /** Own values advanced by `frontiers`, without anything the retention
   * floor already reads. Only an explicit mark read publishes a message's
   * mark; display and dwell marks stay local. */
  const advanceOwn = (
    own: Readonly<Record<string, number>> = {},
    frontiers: Readonly<Record<string, number>> = {},
    explicit = false,
  ) => {
    const next: Record<string, number> = {};
    for (const [key, value] of Object.entries(own))
      if (value > floor()) next[key] = value;
    for (const [key, value] of Object.entries(frontiers))
      if (
        !key.startsWith("seen:msg:") &&
        (explicit || !key.startsWith("msg:")) &&
        value > floor()
      )
        next[key] = Math.max(next[key] ?? 0, value);
    return next;
  };
  const homeLookup =
    (saved: Readonly<Record<string, string>> = {}) =>
    (id: string) =>
      saved[id] ?? coverage?.home(id);
  const coveredWith = (
    home: (id: string) => string | undefined,
  ): CoveredFrontier | undefined =>
    coverage && ((key, frontier) => coverage?.covered(key, frontier, home));
  /** `retainLocalRead`, with the channels of the messages that the kept
   * marks name. Each save records the channel of every loaded message that a
   * kept mark names, so the mark can still be covered after a reload. */
  function retainMarks(
    current: ReadJournal,
    states: readonly ReadState[],
    recent: Readonly<Record<string, number>>,
    learned: Readonly<Record<string, string>> = {},
  ) {
    const home = homeLookup({ ...current.homes, ...learned });
    const kept = retainLocalRead(
      states,
      recent,
      current.clientId,
      current.reserve,
      coveredWith(home),
      current.floor,
    );
    const homes: Record<string, string> = {};
    for (const key of [
      ...Object.keys(kept.state.frontiers),
      ...Object.keys(kept.reserve),
    ]) {
      const id = markMessage(key);
      const channel = id === undefined ? undefined : home(id);
      // A channel the saved record cannot hold is used for this save's
      // pruning but not kept, so it cannot make the whole save fail.
      if (id !== undefined && contextId(channel)) homes[id] = channel;
    }
    return { ...kept, homes: Object.freeze(homes) };
  }
  async function save(
    change: (current: ReadJournal) => ReadJournal,
    announce = true,
  ) {
    if (closed) throw new Error("Read-state session closed");
    const saved = await storage.update((current) => {
      if (closed) throw new Error("Read-state session closed");
      const before = current ?? newReadJournal();
      const next = change(before);
      // Ingest and publication bookkeeping need not advance revision. Even an
      // equal-valued later save must prevent rolling back a newer receipt.
      if (
        before.capturedReadUndo &&
        next.capturedReadUndo === before.capturedReadUndo
      ) {
        const { capturedReadUndo, ...retired } = next;
        return retired;
      }
      return next;
    });
    if (closed) return saved;
    journal = saved;
    state = localState(saved);
    if (announce) broadcast?.postMessage("changed");
    emit();
    return saved;
  }
  /** A peer's save is already durable, so load it without writing it back.
   * Only a missing record (first use, or cleared elsewhere) still saves. */
  async function load() {
    const current = await storage.read?.();
    if (!current) return save((current) => current, false);
    if (closed) return;
    journal = current;
    state = localState(current);
    emit();
  }
  const ready = queue(async () => {
    try {
      await save((current) => current, false);
      if (!closed)
        health({
          status:
            journal?.pending ||
            (journal && journal.revision > journal.acceptedRevision)
              ? "pending"
              : "local",
        });
    } catch (error) {
      health({
        status: "error",
        error: `Read-state storage: ${errorText(error)}`,
      });
    }
  });
  function undoLocalRead(
    actionSlot: string,
    actionRevision: number,
    cleared: readonly string[],
    valid: Validity,
    options?: LocalUnreadUndo,
    captured?: CapturedReadUndo,
  ): (() => Promise<ReadMutationResult>) | undefined {
    if (
      !options ||
      (!cleared.length && !captured) ||
      !cleared.every((key) => options.keys.has(key))
    )
      return;
    return () => {
      const attempts: LocalUnreadAttempt[] = cleared.map((key) => ({ key }));
      for (const attempt of attempts) pendingLocalUnread.add(attempt);
      return queue(async () => {
        await ready;
        if (!journal)
          throw new Error("Saved read state unavailable; retry storage first");
        try {
          const saved = await save((current) => {
            // Revision catches newer mark-then-clear intent; slot also catches a
            // replacement journal whose counter has reached the same revision.
            if (
              !valid(current) ||
              !options.valid() ||
              current.slot !== actionSlot ||
              current.revision !== actionRevision ||
              (captured !== undefined &&
                current.capturedReadUndo !== captured.token) ||
              cleared.some((key) => current.localUnread[key] !== undefined)
            )
              throw new ObservationExpired();
            const revision = current.revision + 1;
            const localUnread = { ...current.localUnread };
            for (const key of cleared) localUnread[key] = revision;
            return {
              ...current,
              // Only device-local receipt/retention effects are reverted. The
              // action never advances synced prefixes; own/publication state stays.
              ...(captured?.before ?? {}),
              revision,
              localUnread,
              acceptedRevision:
                current.acceptedRevision === current.revision
                  ? revision
                  : current.acceptedRevision,
            };
          });
          for (const attempt of attempts)
            attempt.saved = { revision: saved.revision, previous: 0 };
          health({
            status:
              saved.pending || saved.revision > saved.acceptedRevision
                ? "pending"
                : "local",
            error: undefined,
          });
          return {
            operationId: `${saved.slot}:${saved.revision}`,
            durability: "saved" as const,
            sync: "local-only" as const,
          };
        } catch (error) {
          if (!(error instanceof ObservationExpired))
            health({ status: "error", error: errorText(error) });
          throw error;
        }
      }).finally(() => {
        for (const attempt of attempts) pendingLocalUnread.delete(attempt);
      });
    };
  }
  if (broadcast)
    broadcast.onmessage = () => {
      void queue(async () => {
        try {
          await load();
          reconcileJournal();
        } catch (error) {
          health({ status: "error", error: errorText(error) });
        }
      });
    };
  function reconcileJournal() {
    if (closed || !journal) return;
    if (journal.pending || journal.revision > journal.acceptedRevision) {
      if (journal.revision > attemptedRevision) {
        health({ status: "pending", error: undefined });
        schedule();
      }
    } else if (
      snapshot.status === "pending" ||
      snapshot.status === "accepted" ||
      (failedRevision !== undefined &&
        journal.acceptedRevision >= failedRevision)
    ) {
      failedRevision = undefined;
      health({
        status: journal.lastCreatedAt > 0 ? "reconciled" : "local",
        error: undefined,
      });
    }
  }
  function schedule() {
    if (closed || capability !== "frontier-sync" || timer || publishing) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, debounceMs);
  }
  async function decode(events: readonly RelayEvent[], signal: AbortSignal) {
    if (!host) throw new Error("Read-state decoding unsupported by this host");
    const selected = new Map<string, RelayEvent>();
    for (const event of events) {
      const coordinate = readCoordinate(event);
      if (event.pubkey === viewer && coordinate)
        selected.set(coordinate, newer(selected.get(coordinate), event));
    }
    const result: { event: RelayEvent; parsed: ParsedReadBlob }[] = [];
    const values = [...selected.values()];
    // Host body bounds apply independently from the aggregate snapshot limit.
    for (let index = 0; index < values.length; index += 4) {
      const batch = values.slice(index, index + 4);
      const decoded = await host.decode(batch, signal);
      signal.throwIfAborted();
      if (!Array.isArray(decoded) || decoded.length !== batch.length)
        throw new Error("Incomplete read-state decode");
      const seen = new Set<string>();
      for (const item of decoded) {
        const event = batch.find((event) => event.id === item.eventId);
        if (!event || seen.has(event.id))
          throw new Error("Read-state decode identity mismatch");
        seen.add(event.id);
        result.push({
          event,
          parsed: channelGroups(parseReadBlob(item.blob)),
        });
      }
    }
    return result;
  }
  async function ingest(
    events: readonly RelayEvent[],
    signal: AbortSignal,
    generation = epoch,
  ) {
    const committed = await decode(events, signal);
    // Merge locally before admitting slot versions. Failed storage must remain retryable.
    await save((current) => {
      signal.throwIfAborted();
      if (closed || generation !== epoch)
        throw new DOMException(
          "Read-state observation cancelled",
          "AbortError",
        );
      // Our own slots can hold values this journal lacks (a restored or
      // cloned profile): recover them, or the next blob would drop them.
      const owned = [current.slot, ...(current.spill ?? [])].map(
        (slot) => `read-state:${slot}`,
      );
      let own = current.own;
      for (const { event, parsed } of committed)
        if (
          parsed.clientId === current.clientId &&
          owned.includes(readCoordinate(event) ?? "")
        )
          own = advanceOwn(own, parsed.state.frontiers, true);
      return {
        ...current,
        ...retainMarks(
          current,
          [current.state, ...committed.map(({ parsed }) => parsed.state)],
          current.recent ?? {},
        ),
        ...(own && { own }),
      };
    });
    if (closed || generation !== epoch) return;
    for (const item of committed) {
      const coordinate = readCoordinate(item.event);
      if (!coordinate) throw new Error("Read-state coordinate missing");
      const old = slots.get(coordinate);
      if (!old || newer(old.event, item.event) === item.event) {
        slots.set(coordinate, item);
        // Every observation keeps the capacity basis current, not only refresh.
        snapshotSizes?.set(coordinate, encodedBytes(item.event));
      }
    }
    if (slots.size > 4096) {
      slots.clear();
      throw new Error("Read-state coordinate capacity exceeded");
    }
  }
  const snapshotted = () => !!host?.communityId && !!reader.readStateSnapshot;
  // An operation's ten seconds, plus the reader's large-read deadline when it
  // reads a complete snapshot: a caller signal shorter than that deadline would
  // cancel the snapshot first.
  const budget = (snapshot: boolean) =>
    AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(10000 + (snapshot ? LARGE_READ_DEADLINE_MS : 0)),
    ]);
  // Sizes of a complete snapshot, kept current by every later observation.
  function basis(events: readonly RelayEvent[]) {
    snapshotSizes = new Map(
      events.map((event) => [dTag(event), encodedBytes(event)]),
    );
  }
  // A local projection, not a reservation: other devices can still grow the
  // snapshot concurrently. Checked before every send, replays included. A gap
  // can drop the basis while a send awaits its signer or storage, so a missing
  // basis refuses the send; the next flush takes a fresh snapshot first.
  function admit(events: readonly RelayEvent[]) {
    if (!snapshotSizes) {
      if (snapshotted())
        throw new Error(
          "Read-state capacity basis lost; saved intent retained",
        );
      return;
    }
    const projected = new Map(snapshotSizes);
    for (const event of events) projected.set(dTag(event), encodedBytes(event));
    let total = 2 + Math.max(0, projected.size - 1);
    for (const size of projected.values()) total += size;
    if (projected.size > READ_SNAPSHOT_EVENTS || total > READ_SNAPSHOT_BYTES)
      throw new Error(
        "Read-state snapshot capacity reached; saved intent retained",
      );
  }
  async function refresh(priority: Priority = "background") {
    requested = true;
    if (closed || !host) return;
    if (refreshing) return refreshing;
    const generation = epoch;
    const signal = budget(snapshotted());
    const task = queue(async () => {
      try {
        await ready;
        if (!journal) throw new Error("Saved read state unavailable");
        const complete = snapshotted();
        const events =
          complete && reader.readStateSnapshot
            ? await reader.readStateSnapshot({
                signal,
                priority,
                fresh: true,
              })
            : await reader.read(
                [
                  {
                    kinds: [30078],
                    authors: [viewer],
                    "#t": ["read-state"],
                    limit: 500,
                  },
                ],
                { signal, priority },
              );
        await ingest(events, signal, generation);
        if (closed || generation !== epoch) return;
        if (complete) basis(events);
        observationOwed = false;
        health({
          status:
            journal.pending || journal.revision > journal.acceptedRevision
              ? "pending"
              : "reconciled",
          completeness: complete ? "snapshot" : "bounded",
          error: undefined,
        });
        if (journal.pending || journal.revision > journal.acceptedRevision)
          schedule();
      } catch (error) {
        if (!closed && generation === epoch) {
          observationOwed = true;
          health({ status: "error", error: errorText(error) });
        }
      }
    });
    refreshing = task.finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }
  /** Sets or clears the channel override groups an action covers, per the
   * Actions of NIP-RS: a set needs a complete load and must fit the primary;
   * a clear bumps only groups that are still live. Undefined: nothing synced. */
  function changeGroups(
    current: ReadJournal,
    key: string,
    unread: boolean | undefined,
    clearKeys: readonly string[],
  ): ReadState | undefined {
    if (capability !== "frontier-sync" || unread === undefined) return;
    const frontier = (state: ReadState, ctx: string) =>
      localState({ ...current, state }).frontiers[ctx];
    let next = current.state;
    if (unread) {
      // Without a complete load the mark stays on this device, labelled so.
      if (!channelContext(key) || snapshot.completeness !== "snapshot") return;
      next = changeOverride(next, key, true, frontier(next, key) ?? 0);
      groupBlob(current.clientId, next, (ctx) => frontier(next, ctx));
      return next;
    }
    for (const ctx of new Set([key, ...clearKeys]))
      if (
        channelContext(ctx) &&
        overrideActive(next.overrides[ctx], frontier(next, ctx))
      )
        next = changeOverride(next, ctx, false, 0);
    return next === current.state ? undefined : next;
  }
  async function mutate(
    key: string,
    timestamp: number | undefined,
    unread: boolean | undefined,
    valid: Validity,
    clearLocalKeys: readonly string[] = [key],
    fence?: LocalUnreadFence,
    localUnreadAttempt?: LocalUnreadAttempt,
    undoOptions?: LocalUnreadUndo,
  ): Promise<ReadMutationResult> {
    return queue<ReadMutationResult>(async () => {
      await ready;
      if (!journal)
        throw new Error("Saved read state unavailable; retry storage first");
      if (timestamp !== undefined && capability !== "frontier-sync")
        throw new Error("Read-state sync unsupported by this host");
      try {
        const currentValid = fence
          ? await capturedValidity(valid, fence)
          : valid;
        let previousLocalUnread = 0;
        let synced = false;
        const clearedLocalUnread: string[] = [];
        const saved = await save((current) => {
          if (!currentValid(current)) throw new ObservationExpired();
          if (
            !contextId(key) ||
            (timestamp !== undefined && !uint32(timestamp))
          )
            throw new Error("Invalid read frontier");
          const revision = current.revision + 1;
          const recent =
            timestamp === undefined
              ? (current.recent ?? {})
              : { ...current.recent, [key]: revision };
          const kept =
            timestamp === undefined
              ? {
                  state: current.state,
                  recent,
                  reserve: current.reserve ?? {},
                  homes: current.homes ?? {},
                  floor: current.floor ?? 0,
                }
              : retainMarks(
                  current,
                  [
                    current.state,
                    { frontiers: { [key]: timestamp }, overrides: {} },
                  ],
                  recent,
                );
          const localUnread = { ...current.localUnread };
          previousLocalUnread = localUnread[key] ?? 0;
          // Automatic observations do not clear explicit local manual-unread intent.
          if (unread === false)
            for (const clearKey of new Set(clearLocalKeys)) {
              const previous = localUnread[clearKey];
              if (undoOptions && previous !== undefined)
                clearedLocalUnread.push(clearKey);
              delete localUnread[clearKey];
            }
          const own = advanceOwn(
            current.own,
            timestamp === undefined ? {} : { [key]: timestamp },
            unread === false,
          );
          // A whole channel's mark unread, and its clears, sync as override
          // groups; message and thread mark unread stay on this device.
          const groups = changeGroups(
            { ...current, state: kept.state, reserve: kept.reserve, own },
            key,
            unread,
            clearLocalKeys,
          );
          if (groups) kept.state = groups;
          if (unread === true && !groups) localUnread[key] = revision;
          synced = timestamp !== undefined || !!groups;
          return {
            ...current,
            revision,
            state: kept.state,
            recent: kept.recent,
            reserve: kept.reserve,
            homes: kept.homes,
            floor: kept.floor,
            own,
            localUnread,
            acceptedRevision:
              !synced && current.acceptedRevision === current.revision
                ? revision
                : current.acceptedRevision,
          };
        });
        if (localUnreadAttempt)
          localUnreadAttempt.saved = {
            revision: saved.revision,
            previous: previousLocalUnread,
          };
        health({
          status: capability === "frontier-sync" ? "pending" : "local",
          error: undefined,
        });
        if (synced) schedule();
        const undo = undoLocalRead(
          saved.slot,
          saved.revision,
          clearedLocalUnread,
          currentValid,
          undoOptions,
        );
        return {
          operationId: `${saved.slot}:${saved.revision}`,
          durability: "saved",
          sync:
            capability === "frontier-sync" && synced ? "pending" : "local-only",
          ...(undo && { undo }),
        };
      } catch (error) {
        if (!(error instanceof ObservationExpired))
          health({ status: "error", error: errorText(error) });
        throw error;
      }
    });
  }
  async function flush() {
    if (closed || capability !== "frontier-sync" || !lock || !host?.sign)
      return;
    if (publishing) return publishing;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    let signal = budget(false);
    const sign = host.sign;
    const task = queue(async () => {
      try {
        await ready;
        attemptedRevision = journal?.revision ?? attemptedRevision;
        await lock(signal, async () => {
          await save((current) => current, false);
          if (!journal) throw new Error("Saved read state unavailable");
          attemptedRevision = journal.revision;
          // A restart or gap leaves no capacity basis: take one before any send.
          if (!snapshotSizes && snapshotted() && reader.readStateSnapshot) {
            // Decided here, not at the call: a gap while this flush waited
            // can drop the basis. The lock only uses its signal to acquire.
            signal = budget(true);
            const generation = epoch;
            const observed = await reader.readStateSnapshot({
              signal,
              priority: "background",
              fresh: true,
            });
            await ingest(observed, signal, generation);
            // A gap during the fetch invalidates this basis too.
            if (closed || generation !== epoch) return;
            basis(observed);
          }
          // Unknown outcomes retry exact bytes; only expired, rejected state may be renewed.
          if (journal.pending) {
            admit([journal.pending.event]);
            await publishPending(signal, true);
          }
          if (journal.revision <= journal.acceptedRevision) return;
          const owned = [journal.slot, ...(journal.spill ?? [])];
          const events = await reader.read(
            [
              {
                kinds: [30078],
                authors: [viewer],
                "#d": owned.map((slot) => `read-state:${slot}`),
                limit: owned.length,
              },
            ],
            { signal, priority: "background", fresh: true },
          );
          await ingest(events, signal);
          const seen = owned.map((slot) => slots.get(`read-state:${slot}`));
          if (
            seen.some((own) => own && own.parsed.clientId !== journal?.clientId)
          )
            throw new Error("Read-state slot conflict; publication blocked");
          // The acknowledged revision is the one this plan was packed from;
          // anything saved later, even during the spill save, stays pending.
          const revision = journal.revision;
          // Own frontiers, and the merged union of every installation's
          // channel override groups, which only the primary carries.
          const ownFrontiers = advanceOwn(journal.own);
          const merged = localState(journal);
          const groups = groupBlob(
            journal.clientId,
            { frontiers: ownFrontiers, overrides: journal.state.overrides },
            (key) => merged.frontiers[key],
          );
          const plan = packReadState(
            journal.clientId,
            ownFrontiers,
            owned.map((slot, index) => ({
              slot,
              carried: Object.keys(seen[index]?.parsed.state.frontiers ?? {}),
            })),
            newSlotId,
            undefined,
            groups,
          );
          const primaryGroups = parseReadBlob(groups).state.overrides;
          if (plan.length > READ_STATE_SLOTS)
            throw new Error(
              "Read-state publication capacity reached; saved intent retained",
            );
          // New slots are owned before anything is published to them.
          if (plan.length > owned.length)
            await save((current) => ({
              ...current,
              spill: plan.slice(1).map(({ slot }) => slot),
            }));
          // Only slots missing one of their own values are written: an
          // unchanged blob keeps its event, and an emptied one stays inert.
          // A blob that drops a key it carries goes last, after the key's new
          // home, so no frontier is ever off the relay.
          const drops = (index: number) =>
            Object.keys(seen[index]?.parsed.state.frontiers ?? {}).some(
              (key) => !(key in (plan[index]?.frontiers ?? {})),
            );
          const changed = plan
            .map((blob, index) => ({ ...blob, index }))
            .filter(
              ({ frontiers, index }) =>
                Object.entries(frontiers).some(
                  ([key, value]) =>
                    (seen[index]?.parsed.state.frontiers[key] ?? -1) < value,
                ) ||
                (index === 0 &&
                  !same(seen[0]?.parsed.state.overrides ?? {}, primaryGroups)),
            )
            .sort((a, b) => Number(drops(a.index)) - Number(drops(b.index)));
          attemptedRevision = revision;
          if (!changed.length) {
            const expired = journal.pending?.event.id;
            await save((current) => {
              // An expired envelope whose values the relay already holds
              // needs no replacement.
              const { pending, ...rest } = current;
              return {
                ...(pending?.event.id === expired ? rest : current),
                acceptedRevision: Math.max(current.acceptedRevision, revision),
              };
            });
            health({ status: "reconciled", error: undefined });
            return;
          }
          const signed: RelayEvent[] = [];
          for (const { slot, frontiers, index } of changed) {
            const coordinate = `read-state:${slot}`;
            const state = {
              frontiers,
              overrides: index === 0 ? primaryGroups : {},
            };
            const payload = readBlob(journal.clientId, state, () => undefined);
            // Above every version this installation ever signed, so a
            // successor always supersedes a pending event the relay missed.
            const createdAt = readVersion(
              now(),
              Math.max(
                journal.lastCreatedAt,
                slots.get(coordinate)?.event.created_at ?? 0,
              ),
            );
            const event = await sign(
              { slot, createdAt, blob: payload },
              signal,
            );
            signal.throwIfAborted();
            if (
              event.pubkey !== viewer ||
              readCoordinate(event) !== coordinate ||
              event.created_at !== createdAt
            )
              throw new Error("Read-state signer changed identity or version");
            // Decode signed output too: a host response cannot acknowledge a different plaintext.
            const decoded = await decode([event], signal);
            if (
              decoded[0]?.parsed.clientId !== journal.clientId ||
              !same(decoded[0]?.parsed.state, parseReadBlob(payload).state)
            )
              throw new Error("Read-state signer changed the payload");
            signed.push(event);
          }
          // Every prefix must fit: a later blob's shrink is no credit until
          // it reaches the relay.
          for (let end = 1; end <= signed.length; end++)
            admit(signed.slice(0, end));
          for (const [index, event] of signed.entries()) {
            // Only the last blob acknowledges the revision: a partial
            // publication never marks local intent as synchronized.
            const last = index === signed.length - 1;
            await save((current) => ({
              ...current,
              lastCreatedAt: Math.max(current.lastCreatedAt, event.created_at),
              pending: {
                event,
                revision: last ? revision : current.acceptedRevision,
              },
            }));
            // Saving awaited storage: fence the send itself, not just the plan.
            // Earlier blobs are observed by now, so the basis already holds them.
            admit([event]);
            await publishPending(signal);
          }
        });
      } catch (error) {
        if (!closed) {
          health({ status: "error", error: errorText(error) });
          failedRevision =
            journal &&
            (journal.pending || journal.revision > journal.acceptedRevision)
              ? journal.revision
              : undefined;
        }
      }
    });
    publishing = task.finally(() => {
      publishing = undefined;
      // Peer intent may have arrived during signing/readback, ahead of its broadcast.
      reconcileJournal();
    });
    return publishing;
  }
  async function publishPending(signal: AbortSignal, recover = false) {
    const before = journal;
    const pending = before?.pending;
    if (!pending || !before) return;
    if (!host?.publish) throw new Error("Read-state publication unavailable");
    health({ status: "pending", error: undefined });
    let expired = false;
    try {
      await host.publish(pending.event, signal);
    } catch (error) {
      // A timestamp refusal also covers future clock skew. Only renew old state,
      // outside the signer's 60s clock allowance, and at most once per flush.
      if (
        !recover ||
        !(error instanceof ReadStateTimestampRejected) ||
        pending.event.created_at >= now() - 60
      )
        throw error;
      expired = true;
    }
    signal.throwIfAborted();
    // Acknowledgement is not coordinate observation. An expired retry may also
    // have been stored before its original response was lost.
    if (!expired) health({ status: "accepted" });
    const coordinate = readCoordinate(pending.event);
    if (!coordinate) throw new Error("Read-state coordinate missing");
    const events = await reader.read(
      [
        {
          kinds: [30078],
          authors: [viewer],
          "#d": [coordinate],
          limit: 500,
        },
      ],
      { signal, priority: "background", fresh: true },
    );
    await ingest(events, signal);
    const own = slots.get(coordinate);
    const payload = (await decode([pending.event], signal))[0]?.parsed;
    if (!payload) throw new Error("Saved read-state decode missing");
    if (own && own.parsed.clientId !== before.clientId)
      throw new Error("Read-state slot conflict; publication blocked");
    const observed =
      !!own &&
      same(mergeReadStates(own.parsed.state, payload.state), own.parsed.state);
    if (!observed) {
      if (!expired)
        throw new Error(
          "Read-state accepted; coordinate observation still pending",
        );
      // Keep the old envelope until its replacement is saved by flush. Merge its
      // plaintext durably without acknowledging it or erasing newer local intent.
      await save((current) => {
        if (current.pending?.event.id !== pending.event.id) return current;
        return {
          ...current,
          ...retainMarks(
            current,
            [current.state, payload.state],
            current.recent ?? {},
          ),
          own: advanceOwn(current.own, payload.state.frontiers, true),
        };
      });
      return;
    }
    const saved = await save((current) => {
      if (current.pending?.event.id !== pending.event.id) return current;
      const { pending: _pending, ...rest } = current;
      return {
        ...rest,
        acceptedRevision: Math.max(current.acceptedRevision, pending.revision),
      };
    });
    health({
      status:
        saved.revision > saved.acceptedRevision ? "pending" : "reconciled",
      error: undefined,
    });
  }
  return {
    ready,
    captureLocalUnread,
    captureLocalUnreadRevision,
    snapshot: () => snapshot,
    /** Markers may be missing: a snapshot read is still owed. */
    owed: () => observationOwed,
    state: () => state,
    localUnread: (key: string) => journal?.localUnread[key],
    localUnreadKeys: () => Object.keys(journal?.localUnread ?? {}),
    revision: () => journal?.revision ?? 0,
    /** `revision`, less quiet saves from any window: they change no unread
     * state, so a reader's entry evidence outlives them. */
    intentRevision: () => (journal?.revision ?? 0) - (journal?.quiet ?? 0),
    /** Every message at or before this time counts as read: the retention
     * window, or the local floor that dropped marks raised, whichever is
     * later. Publication uses only the retention window. */
    floor: () => Math.max(floor(), journal?.floor ?? 0),
    /** Lets the next save drop marks that broader marks already cover. */
    setCoverage(next: MarkCoverage | undefined) {
      coverage = next;
    },
    /** The saved channel of a message that a kept mark names. */
    home: (id: string) => journal?.homes?.[id],
    /** Saves channels found for marked messages (from signed events) and
     * drops the marks that they show are covered. Like a synced update, this
     * changes no read, so it publishes nothing. */
    learnHomes: (found: Readonly<Record<string, string>>) =>
      queue(async () => {
        await ready;
        if (!journal || closed) return;
        await save((current) => ({
          ...current,
          ...retainMarks(current, [current.state], current.recent ?? {}, found),
        }));
      }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    ensure: () =>
      refreshing ?? (requested ? Promise.resolve() : refresh("foreground")),
    flush,
    read: (
      key: string,
      timestamp: number,
      valid: Validity,
      explicit = false,
      clearLocalKeys?: readonly string[],
      fence?: LocalUnreadFence,
      undoOptions?: LocalUnreadUndo,
    ) =>
      mutate(
        key,
        timestamp,
        explicit ? false : undefined,
        valid,
        clearLocalKeys,
        fence,
        undefined,
        undoOptions,
      ),
    clearLocalUnread: (
      key: string,
      keys: readonly string[],
      valid: Validity,
      fence?: LocalUnreadFence,
      undoOptions?: LocalUnreadUndo,
    ) =>
      mutate(key, undefined, false, valid, keys, fence, undefined, undoOptions),
    /** Atomic explicit subtree read; local-only hosts clear intent without
     * fabricating frontiers. A `quiet` save (a row's `seen:` marks) reads
     * nothing, so it is counted apart from unread intent (`intentRevision`). */
    readMessages: (
      messages: readonly Readonly<{
        key: string;
        timestamp: number;
        channelId: string;
        rootId?: string | undefined;
      }>[],
      clearForce: string | undefined,
      valid: Validity,
      quiet = false,
      fence?: LocalUnreadFence,
      clearLocalKeys: readonly string[] = [],
      options: {
        preserveCapturedSet?: boolean;
        undo?: LocalUnreadUndo;
        /** An explicit Mark read of these messages: their marks sync. */
        explicit?: boolean;
      } = {},
    ) =>
      queue(async () => {
        await ready;
        if (!journal)
          throw new Error("Saved read state unavailable; retry storage first");
        try {
          const currentValid = fence
            ? await capturedValidity(valid, fence)
            : valid;
          const clearedLocalUnread = new Set<string>();
          const token =
            options.preserveCapturedSet && options.undo
              ? newSlotId()
              : undefined;
          let captured: CapturedReadUndo | undefined;
          const saved = await save((current) => {
            if (!currentValid(current)) throw new ObservationExpired();
            if (
              messages.some(
                ({ key, timestamp }) => !contextId(key) || !uint32(timestamp),
              )
            )
              throw new Error("Invalid read frontier");
            if (token) {
              if (
                messages.some(({ key }) => !key.startsWith("msg:")) ||
                clearForce
              )
                throw new Error(
                  "Captured Undo requires exact message receipts",
                );
              captured = {
                token,
                before: {
                  state: current.state,
                  recent: current.recent ?? {},
                  reserve: current.reserve ?? {},
                  homes: current.homes ?? {},
                  floor: current.floor ?? 0,
                },
              };
            }
            const currentState = localState(current);
            if (
              capability !== "frontier-sync" &&
              messages.some(
                ({ key, timestamp, channelId, rootId }) =>
                  (effectiveFrontier(currentState, key, channelId, rootId) ??
                    -1) < timestamp,
              )
            )
              throw new Error("Read-state sync unsupported by this host");
            const revision = current.revision + 1;
            const recent = { ...current.recent };
            const frontiers: Record<string, number> = {};
            const localUnread = { ...current.localUnread };
            for (const { key, timestamp } of messages) {
              if (capability === "frontier-sync") {
                recent[key] = revision;
                frontiers[key] = Math.max(frontiers[key] ?? 0, timestamp);
              }
            }
            const clearLocalUnread = (key: string) => {
              const previous = localUnread[key];
              if (options.undo && previous !== undefined)
                clearedLocalUnread.add(key);
              delete localUnread[key];
            };
            for (const { key } of messages) clearLocalUnread(key);
            if (clearForce) clearLocalUnread(clearForce);
            for (const key of clearLocalKeys) clearLocalUnread(key);
            const kept = Object.keys(frontiers).length
              ? retainMarks(
                  current,
                  [current.state, { frontiers, overrides: {} }],
                  recent,
                )
              : {
                  state: current.state,
                  recent,
                  reserve: current.reserve ?? {},
                  homes: current.homes ?? {},
                  floor: current.floor ?? 0,
                };
            if (
              options.preserveCapturedSet &&
              kept.floor > (current.floor ?? 0)
            ) {
              // The local floor reads every older message, beyond the captured set.
              throw new CapturedReadWouldWidenError();
            }
            if (options.preserveCapturedSet) {
              const retainedFrontiers = {
                ...kept.reserve,
                ...kept.state.frontiers,
              };
              const retainedState = {
                frontiers: retainedFrontiers,
                overrides: kept.state.overrides,
              };
              const home = homeLookup({ ...current.homes, ...kept.homes });
              const covered = coveredWith(home);
              if (
                messages.some(({ key, timestamp, channelId }) => {
                  if (
                    timestamp <= kept.floor ||
                    (effectiveFrontier(retainedState, key, channelId) ?? -1) >=
                      timestamp
                  )
                    return false;
                  const cover = covered?.(key, (other) =>
                    other === key ? timestamp : retainedFrontiers[other],
                  );
                  return (
                    cover === undefined ||
                    (retainedFrontiers[cover] ?? -1) < timestamp
                  );
                })
              )
                throw new CapturedReadNotRetainedError();
            }
            return {
              ...current,
              revision,
              state: kept.state,
              recent: kept.recent,
              reserve: kept.reserve,
              homes: kept.homes,
              floor: kept.floor,
              own: advanceOwn(current.own, frontiers, options.explicit),
              localUnread,
              ...(token && { capturedReadUndo: token }),
              ...(quiet && { quiet: (current.quiet ?? 0) + 1 }),
              acceptedRevision:
                Object.keys(frontiers).length && !token
                  ? current.acceptedRevision
                  : current.acceptedRevision === current.revision
                    ? revision
                    : current.acceptedRevision,
            };
          });
          const publishable =
            capability === "frontier-sync" && messages.length > 0 && !token;
          health({
            status:
              saved.pending || saved.revision > saved.acceptedRevision
                ? "pending"
                : "local",
            error: undefined,
          });
          if (publishable) schedule();
          const clearedKeys = [...clearedLocalUnread];
          const undo = undoLocalRead(
            saved.slot,
            saved.revision,
            clearedKeys,
            currentValid,
            options.undo,
            captured,
          );
          return {
            operationId: `${saved.slot}:${saved.revision}`,
            durability: "saved" as const,
            sync: publishable ? ("pending" as const) : ("local-only" as const),
            ...(undo && { undo }),
          };
        } catch (error) {
          if (!(error instanceof ObservationExpired))
            health({ status: "error", error: errorText(error) });
          throw error;
        }
      }),
    async markLocalUnread(
      key: string,
      valid: () => boolean,
      enqueue: (
        save: () => Promise<ReadMutationResult>,
      ) => Promise<ReadMutationResult> = (save) => save(),
    ) {
      const attempt: LocalUnreadAttempt = { key };
      pendingLocalUnread.add(attempt);
      try {
        return await enqueue(() =>
          mutate(key, undefined, true, valid, undefined, undefined, attempt),
        );
      } finally {
        pendingLocalUnread.delete(attempt);
      }
    },
    accept(events: readonly RelayEvent[]) {
      if (
        closed ||
        !host ||
        !events.some(
          (event) => event.pubkey === viewer && readCoordinate(event),
        )
      )
        return;
      const generation = epoch;
      const signal = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(10000),
      ]);
      void queue(async () => {
        try {
          await ingest(events, signal, generation);
        } catch (error) {
          if (!closed && generation === epoch) {
            observationOwed = true;
            health({ status: "error", error: errorText(error) });
          }
          // A drop cancelled it: the replay may not carry it again, so the
          // snapshot is read again instead of resuming.
          else resumable = undefined;
        }
      });
    },
    stale() {
      resumable =
        snapshot.completeness !== "unknown" &&
        snapshot.status !== "error" &&
        snapshot.status !== "stale"
          ? snapshot.completeness
          : undefined;
      epoch++;
      // Capacity needs a fresh complete snapshot after a gap.
      snapshotSizes = undefined;
      observationOwed = true;
      health({ status: "stale", completeness: "unknown" });
    },
    /** The membership route resumed from its cursor and its replay ended
     * under the limit: it fed every marker written since the drop through
     * `accept`, the same `ingest` the snapshot read uses. Once those land, the
     * state the drop interrupted stands again. Without one, or after a
     * failure since, the snapshot is read again as on any reconnect. */
    resume(): Promise<void> {
      if (closed || !host) return Promise.resolve();
      const generation = epoch;
      return queue(async () => {
        await ready;
        const completeness = resumable;
        if (!completeness || !journal || closed || generation !== epoch)
          return false;
        resumable = undefined;
        observationOwed = false;
        const pending =
          journal.pending || journal.revision > journal.acceptedRevision;
        health({
          status: pending ? "pending" : "reconciled",
          completeness,
          error: undefined,
        });
        if (pending) schedule();
        return true;
      })
        .catch(() => false)
        .then((resumed) =>
          resumed || closed || generation !== epoch ? undefined : refresh(),
        );
    },
    dispose() {
      closed = true;
      epoch++;
      lifetime.abort();
      if (timer) clearTimeout(timer);
      listeners.clear();
      slots.clear();
      broadcast?.close();
      storage.close();
    },
  };
}
