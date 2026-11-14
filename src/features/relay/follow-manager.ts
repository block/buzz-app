import { eventDto, type RelayEvent } from "./events";
import {
  capture,
  dirtySlots,
  EMPTY_FOLLOW_SYNC,
  FOLLOW_PLAINTEXT_BYTES,
  FOLLOW_SLOTS,
  hydrate,
  journal as journalPacket,
  mergeFollows,
  observe,
  ownChoices,
  parseFollowPayload,
  plaintext,
  slotPayload,
  tap,
  type FollowEdit,
  type FollowEntry,
  type FollowPacket,
  type FollowHead,
  type FollowPayload,
  type FollowSyncState,
} from "./follow-sync";
import {
  followCoordinate,
  ReadStateTimestampRejected,
  type ReadStateHost,
} from "./read-state-host";
import { record, slotId, uint32 } from "./read-state-model";
import type { ReadPublisherLock } from "./read-state";
import {
  newSlotId,
  type ReadJournal,
  type ReadStateStorage,
} from "./read-state-storage";
import { PublishRejected } from "./outbox";
import type { RelayReader } from "./reader";
import type { ThreadFollows, ThreadFollowStorage } from "./thread-follows";

/** Follow sync state kept in the read-state journal, saved in the same
 * transactions as read state (rules §2). `slots` are the thread-follows
 * slots this installation owns, in placement order. */
export type StoredFollows = Readonly<{
  state: FollowSyncState;
  slots: readonly string[];
  /** The device-local choices were imported (at=0) after a complete merge. */
  imported?: true;
}>;
const EMPTY_STORED: StoredFollows = { state: EMPTY_FOLLOW_SYNC, slots: [] };

const version = (raw: unknown) =>
  record(raw) &&
  typeof raw.id === "string" &&
  /^[0-9a-f]{64}$/.test(raw.id) &&
  uint32(raw.created_at);
const parsePayload = (raw: unknown): FollowPayload => {
  if (!record(raw) || typeof raw.clientId !== "string" || !record(raw.threads))
    throw new Error("Invalid saved follow choices");
  return parseFollowPayload(wire(raw as FollowPayload));
};
/** Storage is untrusted: corrupt follow state is an error, never dropped work. */
export function parseStoredFollows(
  raw: unknown,
  viewer: string,
): StoredFollows {
  const fail = () => {
    throw new Error("Invalid saved follow choices");
  };
  if (!record(raw) || !record(raw.state) || !Array.isArray(raw.slots)) fail();
  const r = raw as Record<string, unknown> & { state: Record<string, unknown> };
  const slots = r.slots as unknown[];
  if (
    !slots.every(slotId) ||
    new Set(slots).size !== slots.length ||
    slots.length > FOLLOW_SLOTS
  )
    fail();
  const { heads, edits, packets, reserved, observed } = r.state;
  if (
    !record(heads) ||
    !record(edits) ||
    !record(packets) ||
    !uint32(reserved) ||
    !uint32(observed)
  )
    fail();
  const owned = (slot: unknown) =>
    typeof slot === "string" && slots.includes(slot);
  const state: FollowSyncState = {
    heads: Object.fromEntries(
      Object.entries(heads as Record<string, unknown>).map(([slot, head]) => {
        if (!owned(slot) || !version(head)) fail();
        const h = head as FollowHead;
        return [
          slot,
          {
            id: h.id,
            created_at: h.created_at,
            payload:
              h.payload === undefined ? undefined : parsePayload(h.payload),
          },
        ];
      }),
    ),
    edits: Object.fromEntries(
      Object.entries(edits as Record<string, unknown>).map(([key, edit]) => {
        if (
          !record(edit) ||
          !owned(edit.slot) ||
          !uint32(edit.r) ||
          !["explicit", "legacy-import"].includes(edit.origin as string) ||
          !(edit.basis === "empty" || version(edit.basis))
        )
          fail();
        const e = edit as unknown as FollowEdit;
        const entry = parseFollowPayload({
          v: 1,
          client_id: "",
          threads: { [key]: wireEntry(e.entry) },
        }).threads[key];
        return [key, { ...e, entry: entry as FollowEntry }];
      }),
    ),
    packets: Object.fromEntries(
      Object.entries(packets as Record<string, unknown>).map(([id, packet]) => {
        if (
          !record(packet) ||
          packet.id !== id ||
          !version(packet) ||
          !owned(packet.slot) ||
          !record(packet.captured) ||
          !Object.values(packet.captured).every(uint32)
        )
          fail();
        const p = packet as unknown as FollowPacket;
        if (p.event !== undefined) {
          const event = eventDto(p.event);
          if (
            event.id !== id ||
            event.pubkey !== viewer ||
            followCoordinate(event) !== `thread-follows:${p.slot}`
          )
            fail();
        }
        return [id, { ...p, payload: parsePayload(p.payload) }];
      }),
    ),
    reserved: reserved as number,
    observed: observed as number,
  };
  return {
    state,
    slots: [...(slots as string[])],
    ...(r.imported === true ? { imported: true as const } : {}),
  };
}
function wireEntry(entry: unknown) {
  if (!record(entry)) return entry;
  const { extra, ...rest } = entry as FollowEntry;
  return { ...extra, ...rest };
}
/** The wire object for a payload, unknown fields included. */
const wire = (payload: FollowPayload): unknown =>
  JSON.parse(plaintext(payload));

export type FollowSyncSnapshot = Readonly<{
  /** `incomplete`: some coordinate is unreadable or not yet loaded, so
   * choices may be missing (NIP-RS). */
  status: "loading" | "pending" | "synchronized" | "failed" | "local";
  complete: boolean;
  error?: string;
}>;

/** One installation's synced thread follow choices (rules §2–5, §7). The
 * startup gate (§6) is not here yet. Exposes `ThreadFollowStorage` for
 * unread, plus an async `set` that resolves only once the choice is saved. */
export function createThreadFollowSync({
  viewer,
  reader,
  host,
  storage,
  lock,
  legacy,
  now = () => Math.floor(Date.now() / 1000),
  debounceMs = 2000,
  notify = (listener) => listener(),
}: {
  viewer: string;
  reader: RelayReader;
  host: ReadStateHost | undefined;
  storage: ReadStateStorage;
  lock?: ReadPublisherLock | undefined;
  /** Device-local choices from before sync: imported once, at=0. */
  legacy: ThreadFollowStorage;
  now?: () => number;
  debounceMs?: number;
  notify?: (listener: () => void) => void;
}) {
  const synced =
    !!host?.decodeFollows && !!host.signFollows && !!host.publishFollows;
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();
  let closed = false;
  let stored: StoredFollows = EMPTY_STORED;
  let clientId = "";
  /** Newest readable or unreadable head of every coordinate we don't own. */
  const peers = new Map<string, FollowHead>();
  let complete = false;
  let merged: ThreadFollows | undefined;
  let snapshot: FollowSyncSnapshot = { status: "loading", complete: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> | undefined;
  let work: Promise<unknown> = Promise.resolve();
  const queue = <T>(job: () => Promise<T>) => {
    const next = work.then(job);
    work = next.catch(() => {});
    return next;
  };
  const emit = () => {
    merged = undefined;
    if (!closed) for (const listener of listeners) notify(listener);
  };
  const health = (next: FollowSyncSnapshot) => {
    snapshot = next;
    emit();
  };
  const settled = () =>
    health({
      status: !synced
        ? "local"
        : Object.keys(stored.state.edits).length ||
            Object.keys(stored.state.packets).length
          ? "pending"
          : "synchronized",
      complete,
    });
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : "Follow choices unavailable";
  /** One atomic journal transaction over the latest saved record. */
  async function save(
    change: (current: StoredFollows, journal: ReadJournal) => StoredFollows,
  ) {
    const saved = await storage.update((current) => {
      if (!current) throw new Error("Saved read state unavailable");
      const before = current.follows ?? EMPTY_STORED;
      const next = change(before, current);
      // One allocator with read-state packets (rules §3).
      const reserved = Math.max(next.state.reserved, current.lastCreatedAt);
      return {
        ...current,
        lastCreatedAt: Math.max(current.lastCreatedAt, next.state.reserved),
        follows: { ...next, state: { ...next.state, reserved } },
      };
    });
    stored = saved.follows ?? EMPTY_STORED;
    clientId = saved.clientId;
    return saved;
  }
  /** Before every allocation: the shared high-water from read state. */
  const shared = (current: StoredFollows, journal: ReadJournal) => ({
    ...current,
    state: hydrate({
      ...current.state,
      reserved: Math.max(current.state.reserved, journal.lastCreatedAt),
    }),
  });
  const ownSlot = (
    current: StoredFollows,
    event: RelayEvent,
    payload?: FollowPayload,
  ) => {
    const slot = followCoordinate(event)?.slice("thread-follows:".length);
    if (!slot) return;
    if (current.slots.includes(slot)) return slot;
    // A restored or cloned profile: our own client's slot that the journal lost.
    if (payload?.clientId === clientId && current.slots.length < FOLLOW_SLOTS)
      return slot;
  };
  const decodeHead = (event: RelayEvent, payload: unknown): FollowHead => {
    let parsed: FollowPayload | undefined;
    try {
      parsed = payload === null ? undefined : parseFollowPayload(payload);
    } catch {
      parsed = undefined;
    }
    return { id: event.id, created_at: event.created_at, payload: parsed };
  };
  /** Validated own events (fetch or live echo) into the journal, read before write. */
  async function ingest(events: readonly RelayEvent[], signal: AbortSignal) {
    const own = events.filter(
      (event) => event.pubkey === viewer && followCoordinate(event),
    );
    if (!own.length || !host?.decodeFollows) return;
    const decoded = await host.decodeFollows(own, signal);
    signal.throwIfAborted();
    if (decoded.length !== own.length)
      throw new Error("Follow decode mismatch");
    const heads = own.map((event, index) => {
      if (decoded[index]?.eventId !== event.id)
        throw new Error("Follow decode mismatch");
      return [event, decodeHead(event, decoded[index]?.payload)] as const;
    });
    await save((current, journal) => {
      let next = shared(current, journal);
      for (const [event, head] of heads) {
        const slot = ownSlot(next, event, head.payload);
        if (!slot) continue;
        next = {
          ...next,
          slots: next.slots.includes(slot) ? next.slots : [...next.slots, slot],
          state: observe(next.state, slot, head),
        };
      }
      return next;
    });
    for (const [event, head] of heads) {
      const coordinate = followCoordinate(event) ?? "";
      if (stored.slots.includes(coordinate.slice("thread-follows:".length)))
        continue;
      const prior = peers.get(coordinate);
      if (
        !prior ||
        head.created_at > prior.created_at ||
        (head.created_at === prior.created_at && head.id < prior.id)
      )
        peers.set(coordinate, head);
    }
  }
  const unreadable = () =>
    [...peers.values()].some((head) => !head.payload) ||
    Object.values(stored.state.heads).some((head) => !head.payload);
  /** Merged choices of every coordinate (rules: greater `at`, unfollow ties). */
  function choices(): ThreadFollows {
    if (merged) return merged;
    const sources: ReadonlyMap<string, FollowEntry>[] = [
      ownChoices(stored.state, clientId),
    ];
    for (const head of peers.values())
      if (head.payload)
        sources.push(new Map(Object.entries(head.payload.threads)));
    const out = mergeFollows(sources);
    // Before the first complete load, device-local choices still apply.
    if (!stored.imported)
      for (const [key, follow] of legacy.read())
        if (!out.has(key)) out.set(key, follow);
    merged = out;
    return out;
  }
  /** Stable placement: a key stays in its slot; new keys fill the first
   * slot with room, then a new slot, within the coordinate limit (§7). */
  function place(current: StoredFollows, key: string, follow: boolean) {
    for (const slot of current.slots)
      if (
        current.state.edits[key]?.slot === slot ||
        current.state.heads[slot]?.payload?.threads[key]
      )
        return { current, slot };
    const entry = { follow, at: uint32(now()) ? now() : 0 };
    for (const slot of current.slots) {
      const payload = slotPayload(current.state, slot, clientId);
      if (current.state.heads[slot] && !current.state.heads[slot]?.payload)
        continue;
      const size = new TextEncoder().encode(
        plaintext({
          ...payload,
          threads: { ...payload.threads, [key]: entry },
        }),
      ).byteLength;
      if (size <= FOLLOW_PLAINTEXT_BYTES) return { current, slot };
    }
    if (current.slots.length + peers.size >= FOLLOW_SLOTS)
      throw new Error("Follow choices are full");
    const slot = newSlotId();
    return { current: { ...current, slots: [...current.slots, slot] }, slot };
  }
  function schedule(delay = debounceMs) {
    if (closed || !synced) return;
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), delay);
  }
  const budget = () =>
    AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]);
  /** Publish every dirty slot and retry retained packets byte-for-byte.
   * Slots are independent: one failing leaves the others' results. */
  function flush(): Promise<void> {
    if (closed || !synced || !host?.signFollows || !host.publishFollows)
      return Promise.resolve();
    if (sending) return sending;
    const signal = budget();
    const run = async () => {
      // Unreadable own heads hold every edit and packet (§5).
      const errors: unknown[] = [];
      // Exact retry of every retained packet first.
      for (const packet of Object.values(stored.state.packets))
        if (
          stored.state.heads[packet.slot]?.payload === undefined &&
          stored.state.heads[packet.slot]
        )
          errors.push(
            new Error("Follow choices are unreadable on this device"),
          );
        else if (packet.event !== undefined)
          await send(
            eventDto(packet.event),
            packet.payload,
            packet.slot,
            signal,
          ).catch((error: unknown) => errors.push(error));
      for (const slot of dirtySlots(stored.state)) {
        if (stored.state.heads[slot] && !stored.state.heads[slot]?.payload) {
          errors.push(
            new Error("Follow choices are unreadable on this device"),
          );
          continue;
        }
        await compose(slot, signal).catch((error: unknown) =>
          errors.push(error),
        );
      }
      if (errors.length) throw errors[0];
    };
    const task = queue(async () => {
      try {
        await (lock ? lock(signal, run) : run());
        settled();
        // A successor may now be owed behind a resolved packet.
        if (dirtySlots(stored.state).length) schedule(0);
      } catch (error) {
        if (!closed)
          health({ status: "failed", complete, error: errorText(error) });
      }
    });
    sending = task.finally(() => {
      sending = undefined;
    });
    return sending;
  }
  async function compose(slot: string, signal: AbortSignal) {
    if (!host?.signFollows) return;
    // Capture and reserve in one transaction with the shared allocator.
    let frozen: NonNullable<ReturnType<typeof capture>>[1] | undefined;
    await save((current, journal) => {
      const base = shared(current, journal);
      const captured = capture(
        base.state,
        slot,
        clientId || journal.clientId,
        now(),
      );
      if (!captured) return current;
      frozen = captured[1];
      return { ...base, state: captured[0] };
    });
    if (!frozen) return;
    const intent = frozen;
    const event = await host.signFollows(
      { slot, createdAt: intent.created_at, payload: wire(intent.payload) },
      signal,
    );
    signal.throwIfAborted();
    if (
      event.pubkey !== viewer ||
      followCoordinate(event) !== `thread-follows:${slot}` ||
      event.created_at !== intent.created_at
    )
      throw new Error("Follow signer changed identity or version");
    // Journal before send; a moved head or another writer's packet discards it.
    let journaled = false;
    await save((current) => {
      if (
        Object.values(current.state.packets).some(
          (packet) => packet.slot === slot,
        )
      )
        return current;
      const next = journalPacket(
        current.state,
        slot,
        { id: event.id, created_at: event.created_at, event },
        intent,
      );
      if (!next) return current;
      journaled = true;
      return { ...current, state: next };
    });
    if (!journaled) {
      // Rebuilt from the new head on the next flush.
      schedule(0);
      return;
    }
    await send(event, intent.payload, slot, signal);
  }
  async function send(
    event: RelayEvent,
    payload: FollowPayload,
    slot: string,
    signal: AbortSignal,
  ) {
    if (!host?.publishFollows) return;
    try {
      await host.publishFollows(event, signal);
    } catch (error) {
      // A definite refusal never lands: drop the packet so its edits are
      // recaptured with a fresh reservation. Unknown outcomes keep the exact bytes.
      if (
        error instanceof ReadStateTimestampRejected ||
        error instanceof PublishRejected
      )
        await save((current) => {
          const packets = { ...current.state.packets };
          delete packets[event.id];
          return { ...current, state: { ...current.state, packets } };
        });
      throw error;
    }
    // A positive OK for this exact ID acknowledges with the packet's payload.
    await save((current) => ({
      ...current,
      state: observe(current.state, slot, {
        id: event.id,
        created_at: event.created_at,
        payload,
      }),
    }));
  }
  async function refresh() {
    if (closed) return;
    return queue(async () => {
      try {
        const journal = await storage.update((current) => {
          if (!current) throw new Error("Saved read state unavailable");
          return current;
        });
        stored = journal.follows ?? EMPTY_STORED;
        clientId = journal.clientId;
        stored = { ...stored, state: hydrate(stored.state) };
        if (!synced) {
          health({ status: "local", complete: false });
          return;
        }
        const signal = budget();
        const events = await reader.read(
          [
            {
              kinds: [30078],
              authors: [viewer],
              "#t": ["thread-follows"],
              limit: 500,
            },
          ],
          { signal, priority: "background" },
        );
        await ingest(events, signal);
        complete = !unreadable();
        // Legacy import once, after a complete merge, only for unsynced keys.
        if (complete && !stored.imported) {
          const local = legacy.read();
          const known = mergeFollows([
            ownChoices(stored.state, clientId),
            ...[...peers.values()].map(
              (head) => new Map(Object.entries(head.payload?.threads ?? {})),
            ),
          ]);
          await save((current, journal) => {
            let next = shared(current, journal);
            let batch: number | undefined;
            for (const [key, follow] of local) {
              if (known.has(key)) continue;
              const placed = place(next, key, follow);
              next = {
                ...placed.current,
                state: tap(
                  placed.current.state,
                  placed.slot,
                  key,
                  follow,
                  now(),
                  "legacy-import",
                  batch,
                ),
              };
              batch ??= next.state.reserved;
            }
            return { ...next, imported: true };
          });
        }
        settled();
        if (
          dirtySlots(stored.state).length ||
          Object.keys(stored.state.packets).length
        )
          schedule(0);
      } catch (error) {
        if (!closed)
          health({ status: "failed", complete, error: errorText(error) });
      }
    });
  }
  return {
    read: choices,
    /** Legacy whole-map write: unsupported once synced. */
    write(next: ThreadFollows) {
      if (synced) throw new Error("Use set for synced follow choices");
      legacy.write(next);
      emit();
    },
    /** Saves one explicit choice; resolves only after it is durable (§3). */
    set(key: string, follow: boolean): Promise<void> {
      if (!synced) {
        const next = new Map(legacy.read());
        next.delete(key);
        next.set(key, follow);
        legacy.write(next);
        emit();
        return Promise.resolve();
      }
      return queue(async () => {
        if (Object.values(stored.state.heads).some((head) => !head.payload))
          throw new Error("Follow choices are unreadable on this device");
        await save((current, journal) => {
          const placed = place(shared(current, journal), key, follow);
          return {
            ...placed.current,
            state: tap(placed.current.state, placed.slot, key, follow, now()),
          };
        });
        settled();
        schedule();
      });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      const stop = legacy.subscribe(emit);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
    snapshot: () => snapshot,
    refresh,
    flush,
    /** Live own events: echoes and other devices' slots. */
    accept(events: readonly RelayEvent[]) {
      if (
        closed ||
        !synced ||
        !events.some(
          (event) => event.pubkey === viewer && followCoordinate(event),
        )
      )
        return;
      void queue(async () => {
        try {
          await ingest(events, budget());
          complete = complete && !unreadable();
          settled();
          if (dirtySlots(stored.state).length) schedule();
        } catch (error) {
          if (!closed)
            health({ status: "failed", complete, error: errorText(error) });
        }
      });
    },
    dispose() {
      closed = true;
      clearTimeout(timer);
      lifetime.abort();
      listeners.clear();
    },
  };
}
export type ThreadFollowSync = ReturnType<typeof createThreadFollowSync>;
