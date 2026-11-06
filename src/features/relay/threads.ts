import { isRetryableRead, retryRead } from "./read-retry";
import {
  canonicalChannel,
  MissingThreadBounds,
  threadBounds,
  type ThreadCursor,
} from "./thread-window";
import { threadReference } from "./thread-reference";
export { threadReference } from "./thread-reference";
import type { ChannelMessage } from "./contracts";
import type { EventData, ReadFilter, RelayEvent } from "./events";
import type { LocalEvents } from "./outbox";
import type { Priority, RelayReader } from "./reader";
import { listByteSize } from "./budget";
import { foldMessages } from "./fold";
import { compareMessages, MessageClock } from "./message-order";
import { shareMessageRows } from "./row-identity";

const AUX = new Set([5, 7, 9005, 40003, 39005, 39006]);
const PAGE_SIZE = 50;
const INITIAL_WINDOW_SIZE = 10;
/** Resident pages. Reading past them evicts pages from the window's far end. */
const MAX_PAGES = 10;
/** Resident evidence above which far pages are evicted, never a wipe. */
const MAX_EVENTS = 2000;
const MAX_BYTES = 4 * 1024 * 1024;
/** The relay's `thread_window` row allowlist excludes legacy diffs (kind 40008). */
const STRICT_WINDOW_KINDS = [9, 40002];
const contentKind = (event: EventData) =>
  [9, 40002, 40008].includes(event.kind);
const inChannel = (event: EventData, channelId: string) =>
  event.tags.some(([name, value]) => name === "h" && value === channelId);
/** Relay thread-cursor order (seconds, id); rendered order is `compareMessages`. */
const compare = (a: ThreadCursor, b: ThreadCursor) =>
  a.created_at - b.created_at || a.id.localeCompare(b.id);

export type ThreadSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  root: ChannelMessage | undefined;
  replies: readonly ChannelMessage[];
  error: string | undefined;
  /** Continuation is possible, not a claim about total thread size or exhaustion. */
  canLoadMore: boolean;
  /** The window is full: the next continuation evicts its first page. */
  limited: boolean;
  /** Pages before the window's first were evicted and can be read again. */
  canLoadBack?: boolean;
  /** Traversal order: strict windows continue toward older replies, legacy
   * toward newer ones. */
  direction?: "older" | "forward";
  /** The in-flight or failed read, distinct from the traversal direction. */
  readKind?: "older" | "back" | "refresh" | undefined;
  /** Exact navigation target, folded independently of bounded thread traversal. */
  target?: ChannelMessage | undefined;
  targetStatus?: "loading" | "ready" | "unavailable" | "error" | undefined;
}>;
export type ThreadRetarget =
  | "selected"
  | "different"
  | "unavailable"
  | "error"
  | "cancelled";
export type ThreadView = {
  snapshot(): ThreadSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  /** Continue the traversal by one page. */
  loadMore(): Promise<void>;
  /** Read again the page evicted just before the window. */
  loadBack(): Promise<void>;
  /** Strict windows: reopen at the newest page when newer pages were evicted. */
  latest(): Promise<void>;
  /** Change exact selection only when verified ancestry belongs to this thread. */
  retarget(messageId: string, signal: AbortSignal): Promise<ThreadRetarget>;
  dispose(): void;
};
/** Why an exact read can't show its target: this channel holds no such message
 * (`not-found`), or the read failed (`unavailable`). A failed thread read also
 * fails a target that is its `root`. Undefined while the read may still show it. */
export function threadFailure(
  snapshot: ThreadSnapshot,
  root: boolean,
): "not-found" | "unavailable" | undefined {
  if (root && snapshot.status === "error") return "unavailable";
  if (snapshot.targetStatus === "unavailable") return "not-found";
  if (snapshot.targetStatus === "error") return "unavailable";
  return undefined;
}

/** Session-owned evidence. Finite page cursors NEVER come from the live/local display union. */
export function createThreadView({
  channelId,
  messageId,
  relayAuthor,
  signingAuthority,
  agentOwner,
  reader: sourceReader,
  targetReader: sourceTargetReader = sourceReader,
  admitTarget,
  seed,
  local,
  canAccess,
  canRefresh = canAccess,
  visible,
  notify,
  exact = false,
  priority = "foreground",
  admit = (events) => events,
  clock = new MessageClock(),
  dropped: openedDropped = false,
}: {
  channelId: string;
  messageId: string;
  relayAuthor: string;
  /** Explicit NIP-11 self; only it may attribute messages to others. */
  signingAuthority?: string | undefined;
  agentOwner?: ((pubkey: string) => string | undefined) | undefined;
  reader: RelayReader;
  targetReader?: RelayReader;
  admitTarget?: (events: readonly RelayEvent[]) => readonly RelayEvent[];
  seed: RelayEvent | undefined;
  local: LocalEvents | undefined;
  canAccess(): boolean;
  /** Cached membership can display saved rows but cannot authorize a network retry. */
  canRefresh?(): boolean;
  visible(events: readonly RelayEvent[]): readonly RelayEvent[];
  notify(listener: () => void): void;
  exact?: boolean;
  /** Admission for every read this view makes. A passive reader, one that
   * only decorates a link, takes `background` so an opened or previewed
   * conversation's reads start ahead of it. */
  priority?: Priority | undefined;
  /** The session's send clock; rendered replies raise its channel watermark. */
  clock?: MessageClock;
  /** Exact finite reads enter session reconciliation only after a complete fold. */
  admit?:
    | ((events: readonly RelayEvent[]) => readonly RelayEvent[])
    | undefined;
  /** Opened while the stream was down, or before it was up: the first read
   * is the snapshot its establishment refresh must reach. */
  dropped?: boolean;
}) {
  // These finite thread reads have no session recovery source. Their existing
  // selection/page controllers still own cancellation and stale-result fencing.
  const retrying = (source: RelayReader): RelayReader => ({
    read: (filters, settings) =>
      retryRead(
        (signal) => source.read(filters, { priority, ...settings, signal }),
        settings?.signal ?? new AbortController().signal,
        (error) => canRefresh() && isRetryableRead(error),
      ),
  });
  const reader = retrying(sourceReader);
  const targetReader = retrying(sourceTargetReader);
  const acceptTarget = admitTarget ?? admit;
  let disposed = false;
  let rootId: string | undefined;
  let rootUnavailable = false;
  let targetStatus: ThreadSnapshot["targetStatus"] = exact
    ? "loading"
    : undefined;
  let remote: readonly RelayEvent[] = [];
  let staged: readonly RelayEvent[] = [];
  let selectionStaged: readonly RelayEvent[] = [];
  let selectionController: AbortController | undefined;
  let selectionRevision = 0;
  // Strict reads require transport-supplied binding authority. Missing scope is
  // a configuration error, not evidence of an old relay that permits fallback.
  let mode: "probe" | "older" | "legacy" = canonicalChannel.test(channelId)
    ? "probe"
    : "legacy";
  /** Where each page of the traversal starts (undefined: its origin), plus
   * the continuation past the last page read. Only pages [lo, pages) are
   * resident: the rest were evicted, and are read again from their start. */
  let starts: (ThreadCursor | undefined)[] = [];
  let lo = 0;
  let pages = 0;
  /** The last page read proved more history past it. */
  let hasMore = false;
  const isReply = (event: RelayEvent) =>
    !AUX.has(event.kind) &&
    event.id !== rootId &&
    inChannel(event, channelId) &&
    threadReference(event)?.rootId === rootId;
  /** Replies a strict refresh must reach from its newest page. The selected
   * target is retained beyond traversal by design. */
  const unverified = () =>
    new Set(
      remote
        .filter((event) => isReply(event) && !(exact && event.id === messageId))
        .map((event) => event.id),
    );
  /** Traversal order, as each relay pages: strict windows newest first with
   * ids ascending within a second, legacy oldest first. */
  const order = (a: ThreadCursor, b: ThreadCursor) =>
    mode === "older"
      ? b.created_at - a.created_at || a.id.localeCompare(b.id)
      : compare(a, b);
  /** A row past an evicted page boundary. Each page holds the rows after its
   * start, up to and including the next page's start. */
  const outside = (event: RelayEvent) => {
    const first = lo > 0 ? starts[lo] : undefined;
    const last = pages < starts.length - 1 ? starts[pages] : undefined;
    return (
      (!!first && order(event, first) <= 0) ||
      (!!last && order(event, last) > 0)
    );
  };
  const canContinue = () => hasMore || pages < starts.length - 1;
  const paging = () => ({
    canLoadMore: canContinue(),
    canLoadBack: lo > 0,
    limited: canContinue() && pages - lo >= MAX_PAGES,
  });
  function rewind() {
    starts = [];
    lo = 0;
    pages = 0;
    hasMore = false;
  }
  /** Drop replies outside the window with their overlays. Deletions are kept
   * for the view's lifetime, so an evicted reply read again can never show
   * as undeleted; so are the exact target and every resident reply's
   * ancestors, so eviction never detaches a reply from its parent. */
  function evict(gone: (event: RelayEvent) => boolean = outside) {
    const byId = new Map(remote.map((event) => [event.id, event]));
    const kept = new Set<string>();
    const hold = (id: string | undefined) => {
      for (
        let event = id ? byId.get(id) : undefined;
        event && !kept.has(event.id);
        event = byId.get(threadReference(event)?.parentId ?? "")
      )
        kept.add(event.id);
    };
    for (const event of remote)
      if (isReply(event) && !gone(event)) hold(event.id);
    if (exact) hold(messageId);
    const dropped = new Set(
      remote
        .filter((event) => isReply(event) && !kept.has(event.id))
        .map((event) => event.id),
    );
    if (!dropped.size) return;
    for (let more = true; more; ) {
      more = false;
      for (const event of remote) {
        if (
          !AUX.has(event.kind) ||
          event.kind === 5 ||
          event.kind === 9005 ||
          dropped.has(event.id)
        )
          continue;
        const targets = event.tags.filter(([name]) => name === "e");
        if (
          targets.length &&
          targets.every(([, id]) => dropped.has(id ?? ""))
        ) {
          dropped.add(event.id);
          more = true;
        }
      }
    }
    remote = remote.filter((event) => !dropped.has(event.id));
    if (held) held = new Set([...held].filter((id) => !dropped.has(id)));
  }
  const over = () =>
    remote.length > MAX_EVENTS || listByteSize(remote) > MAX_BYTES;
  /** Evict whole pages from one end until the window fits. The last page
   * always stays, so one oversized page is held rather than lost. */
  function shrink(from: "start" | "end") {
    let moved = false;
    while (pages - lo > 1 && (pages - lo > MAX_PAGES || over())) {
      if (from === "start") lo++;
      else pages--;
      evict();
      moved = true;
    }
    return moved;
  }
  /** Live growth evicts the oldest end, away from where replies arrive. */
  const oldest = () => (mode === "older" ? "end" : "start");
  /** The replies held when the stream dropped, or read while it was down,
   * until the refresh after it is back completes. The re-established stream
   * replays its last minutes before that refresh; those replies are newer
   * than any gap, not overlap with it. */
  let held: Set<string> | undefined;
  /** The stream is down: a completed refresh keeps `held`, taking one from
   * its replies if the view has none. Only its establishment refresh clears it. */
  let dropped = openedDropped;
  let controller: AbortController | undefined;
  /** A refresh requested while a read runs; the stream's return carries over. */
  let again: false | "refresh" | "established" = false;
  /** A page read requested during a background repair, which stays ready. */
  let queued: false | "more" | "back" | "latest" = false;
  let snapshot: ThreadSnapshot = Object.freeze({
    status: "idle",
    root: undefined,
    replies: Object.freeze([]),
    error: undefined,
    canLoadMore: false,
    canLoadBack: false,
    limited: false,
  });
  const listeners = new Set<() => void>();
  // The last fold's local and profile inputs: its operations and the agent
  // owners it looked up.
  let localInputs: ReturnType<LocalEvents["snapshot"]> = [];
  let owners = new Map<string, string | undefined>();
  function related<T extends EventData>(
    events: readonly T[],
    selectedId = exact ? messageId : undefined,
  ): T[] {
    if (!rootId && !selectedId) return [];
    const rows = events.filter(
      (event) =>
        !AUX.has(event.kind) &&
        event.kind !== 39007 &&
        inChannel(event, channelId) &&
        (event.id === rootId ||
          (!!selectedId && event.id === selectedId) ||
          (!!rootId && threadReference(event)?.rootId === rootId)),
    );
    const ids = new Set([
      ...(selectedId ? [selectedId] : []),
      ...[...remote, ...staged, ...selectionStaged, ...rows].map(
        (event) => event.id,
      ),
    ]);
    const result = new Map(rows.map((event) => [event.id, event]));
    // Aux closure includes deletion of an auxiliary, not just direct row overlays.
    for (let hop = 0; hop < 2; hop++) {
      for (const event of events) {
        if (!AUX.has(event.kind) || result.has(event.id)) continue;
        if (
          event.tags.some(
            ([name, value]) => name === "e" && ids.has(value ?? ""),
          )
        ) {
          result.set(event.id, event);
          ids.add(event.id);
        }
      }
    }
    return [...result.values()];
  }
  function union(...batches: readonly (readonly RelayEvent[])[]) {
    return [
      ...new Map(batches.flat().map((event) => [event.id, event])).values(),
    ];
  }
  /** A fold that changed nothing keeps the snapshot and notifies no one. */
  function emit(next: ThreadSnapshot) {
    const keys = Object.keys(next) as (keyof ThreadSnapshot)[];
    if (keys.every((key) => next[key] === snapshot[key])) return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) notify(listener);
  }
  function publishStatus(patch: Partial<ThreadSnapshot>) {
    if (disposed) return;
    emit({
      ...snapshot,
      ...patch,
      ...(exact
        ? {
            target: targetStatus === "ready" ? snapshot.target : undefined,
            targetStatus,
          }
        : {}),
    });
  }
  /** This thread's local operations; others never reach its fold. */
  function localOperations() {
    const operations = (canAccess() ? (local?.snapshot() ?? []) : []).filter(
      // Failed reply intent stays visible for same-event retry, just like channel
      // messages; failed edits/reactions must not change the rendered content.
      (item) => item.delivery !== "failed" || contentKind(item.event),
    );
    const events = new Set(related(operations.map((item) => item.event)));
    return operations.filter((item) => events.has(item.event));
  }
  function publish(patch: Partial<ThreadSnapshot> = {}) {
    if (disposed) return;
    const operations = localOperations();
    localInputs = operations;
    const inputs = new Map(
      remote.map((event) => [event.id, event as EventData]),
    );
    for (const item of operations) inputs.set(item.event.id, item.event);
    const deliveries = new Map(operations.map((item) => [item.event.id, item]));
    const looked = new Map<string, string | undefined>();
    owners = looked;
    const rows = shareMessageRows(
      snapshot.root ? [snapshot.root, ...snapshot.replies] : snapshot.replies,
      foldMessages(
        channelId,
        relayAuthor,
        rootUnavailable && !exact ? [] : [...inputs.values()],
        {
          includeReplies: true,
          signingAuthority,
          agentOwner:
            agentOwner &&
            ((pubkey) => {
              const owner = agentOwner(pubkey);
              looked.set(pubkey, owner);
              return owner;
            }),
        },
      ).map((row) => {
        const item = deliveries.get(row.id);
        return item
          ? Object.freeze({
              ...row,
              delivery: item.delivery,
              deliveryError: item.error,
            })
          : row;
      }),
    );
    const target =
      targetStatus === "ready"
        ? rows.find((row) => row.id === messageId)
        : undefined;
    if (targetStatus === "ready" && !target) targetStatus = "unavailable";
    const readable = rows.filter(
      (row) => !exact || row.id !== messageId || targetStatus === "ready",
    );
    const nextReplies = readable
      .filter(
        (row) =>
          row.id !== rootId && (!rootUnavailable || row.id === messageId),
      )
      .sort(compareMessages);
    for (const row of nextReplies)
      clock.observe(channelId, row.createdAtMs ?? row.createdAt * 1000);
    const replies =
      snapshot.replies.length === nextReplies.length &&
      snapshot.replies.every((row, index) => row === nextReplies[index])
        ? snapshot.replies
        : Object.freeze(nextReplies);
    emit({
      ...snapshot,
      ...patch,
      root: !rootUnavailable
        ? readable.find((row) => row.id === rootId)
        : undefined,
      replies,
      ...(exact ? { target, targetStatus } : {}),
    });
  }
  function receive(events: readonly RelayEvent[]) {
    if (disposed || !canAccess() || (!rootId && !exact)) return;
    // A reply past an evicted page would show beyond the gap; it returns
    // with its page.
    const incoming = related(events).filter(
      (event) => !isReply(event) || !outside(event),
    );
    if (!incoming.length) return;
    remote = union(remote, incoming);
    // A read in progress fits the window when it lands.
    publish(!controller && shrink(oldest()) ? paging() : {});
  }
  if (seed && canAccess() && contentKind(seed) && inChannel(seed, channelId)) {
    rootId = threadReference(seed)?.rootId ?? seed.id;
    if (seed.id === rootId) remote = [seed];
    publish();
  }
  function purge(clear = false) {
    controller?.abort();
    selectionController?.abort();
    selectionController = undefined;
    selectionStaged = [];
    controller = undefined;
    again = false;
    queued = false;
    staged = [];
    if (exact) targetStatus = "loading";
    if (clear || !canAccess()) {
      remote = [];
      staged = [];
      rootId = undefined;
      rewind();
      held = undefined;
    } else remote = visible(remote);
    publish({
      status: "idle",
      canLoadMore: false,
      canLoadBack: false,
      limited: false,
      error: canAccess()
        ? "Thread read interrupted. Refresh to continue."
        : "This channel is no longer available.",
      readKind: undefined,
    });
  }
  // Exact selection shares the same bounded evidence and live reconciliation
  // as initial navigation, but never uses the selected row as a page cursor.
  async function readTarget(
    id: string,
    owned: AbortController,
    expectedRoot?: string,
  ): Promise<ThreadRetarget> {
    const active = () =>
      !disposed &&
      !owned.signal.aborted &&
      (expectedRoot ? selectionController : controller) === owned;
    let pending: readonly RelayEvent[] = [];
    const stage = (events: readonly RelayEvent[]) => {
      pending = events;
      if (expectedRoot) selectionStaged = events;
      else staged = events;
    };
    const response = await targetReader.read(
      [{ ids: [id], "#h": [channelId], limit: 1 }],
      { signal: owned.signal },
    );
    if (!active()) return "cancelled";
    // The reader verifies the wire response; this pure visibility check does
    // not reconcile the bare candidate into this or another published view.
    // Only the complete target/overlay fold enters shared admission below.
    const event = visible(response).find(
      (event) =>
        event.id === id && contentKind(event) && inChannel(event, channelId),
    );
    if (!active()) return "cancelled";
    if (!event) return "unavailable";
    const resolvedRoot = threadReference(event)?.rootId ?? event.id;
    if (expectedRoot && resolvedRoot !== expectedRoot) return "different";
    // Staging makes live overlay deletions resolvable without exposing an
    // incomplete selected fold. Existing displayed content remains untouched.
    stage([event]);
    const overlays = await targetReader.read(
      [{ kinds: [5, 7, 9005, 40003, 39005], "#e": [id], limit: 500 }],
      { signal: owned.signal },
    );
    if (!active()) return "cancelled";
    stage(union(pending, related(overlays, id)));
    const ids = union(remote, pending)
      .filter(
        (event) =>
          AUX.has(event.kind) &&
          event.tags.some(([name, value]) => name === "e" && value === id),
      )
      .map((event) => event.id);
    if (ids.length) {
      const tombstones = await targetReader.read(
        [{ kinds: [5, 9005], "#e": ids, limit: 500 }],
        { signal: owned.signal },
      );
      if (!active()) return "cancelled";
      stage(union(pending, related(tombstones, id)));
    }
    // Live deletions received while reads were held are retained only by this
    // reader; admit them with the fold so every reader withdraws the overlay.
    const staging = new Set(pending.map((event) => event.id));
    const accepted = acceptTarget(
      union(
        pending,
        remote.filter(
          (event) =>
            (event.kind === 5 || event.kind === 9005) &&
            event.tags.some(
              ([name, value]) => name === "e" && staging.has(value ?? ""),
            ),
        ),
      ),
    );
    if (!active()) return "cancelled";
    if (!accepted.some((event) => event.id === id)) {
      stage([]);
      return "unavailable";
    }
    // Rejected first-open evidence must never latch a root that later live
    // traffic could populate. Resolve identity only after final admission.
    if (!expectedRoot) rootId = resolvedRoot;
    const combined = union(remote, related(accepted, id));
    remote = combined;
    stage([]);
    if (
      expectedRoot &&
      !foldMessages(channelId, relayAuthor, combined, {
        includeReplies: true,
        signingAuthority,
        agentOwner,
      }).some((row) => row.id === id)
    ) {
      // Keep real tombstones, but do not replace the selected target with a
      // message whose complete fold is unavailable.
      publish();
      return "unavailable";
    }
    return "selected";
  }
  async function retarget(
    id: string,
    signal: AbortSignal,
  ): Promise<ThreadRetarget> {
    if (disposed || signal.aborted || !canAccess()) return "cancelled";
    if (!/^[0-9a-f]{64}$/.test(id)) return "unavailable";
    // A route hint is never evidence that two messages belong to one thread.
    if (!rootId || !snapshot.root) return "different";
    selectionController?.abort();
    selectionStaged = [];
    const owned = new AbortController();
    const cancel = () => owned.abort();
    signal.addEventListener("abort", cancel, { once: true });
    selectionController = owned;
    try {
      const result = await readTarget(id, owned, rootId);
      if (disposed || owned.signal.aborted || selectionController !== owned)
        return "cancelled";
      if (result !== "selected") return result;
      selectionRevision++;
      messageId = id;
      exact = true;
      targetStatus = "ready";
      publish(
        controller
          ? {}
          : { status: "ready", error: undefined, readKind: undefined },
      );
      return snapshot.targetStatus === "ready" ? "selected" : "unavailable";
    } catch {
      return disposed || owned.signal.aborted || selectionController !== owned
        ? "cancelled"
        : "error";
    } finally {
      signal.removeEventListener("abort", cancel);
      if (selectionController === owned) {
        selectionStaged = [];
        selectionController = undefined;
      }
    }
  }

  /** A refresh re-reads the resident pages; `more` continues the traversal;
   * `back` reads the evicted page before the window again; `latest` reads
   * the first page, replacing a window that had moved off it. */
  async function run(
    kind: "refresh" | "more" | "back" | "latest",
    established = false,
  ) {
    if (disposed) return;
    const replace = kind === "refresh";
    if (controller) {
      if (established) again = "established";
      else if (replace) again ||= "refresh";
      // Reopening at the newest page outranks a page read asked for after it.
      else if (queued !== "latest") queued = kind;
      return;
    }
    if (!canAccess()) {
      purge();
      return;
    }
    if (
      (kind === "more" && !snapshot.canLoadMore) ||
      (kind !== "refresh" && kind !== "more" && !lo)
    )
      return;
    const owned = new AbortController();
    controller = owned;
    // Cleared as this refresh starts, not when the stream came back: a refresh
    // it supersedes still completes against the replies held across the drop.
    if (established) dropped = false;
    const active = () =>
      !disposed && !owned.signal.aborted && controller === owned;
    // Pages [first, first + count) are read from their recorded starts.
    const first = { refresh: lo, more: pages, back: lo - 1, latest: 0 }[kind];
    const count = replace ? Math.max(1, pages - lo) : 1;
    // A page read again ends where the window begins, unless a reply was
    // since backdated into it.
    const boundary = kind === "back" ? starts[lo] : undefined;
    let nextCursor = starts[first];
    let nextPages = first;
    let fetched: readonly RelayEvent[] = [];
    // Repair retains already-verified presentation; only a new/unavailable
    // selection waits for its initial fold. Never unmount a reader on reconnect.
    if (exact && replace && targetStatus !== "ready") targetStatus = "loading";
    // A stream establishment (a reconnect, or a minute renewal) repairs a ready
    // view in the background: it stays ready unless the repair changes it.
    if (!established || snapshot.status !== "ready")
      publishStatus({
        status: "loading",
        error: undefined,
        readKind:
          kind === "more" ? "older" : kind === "back" ? "back" : "refresh",
      });
    try {
      if (exact && replace) {
        const revision = selectionRevision;
        const result = await readTarget(messageId, owned);
        if (!active()) return;
        if (revision === selectionRevision && result !== "selected") {
          targetStatus = "unavailable";
          publish({ status: "ready", canLoadMore: false });
          return;
        }
        if (revision === selectionRevision) {
          targetStatus = "ready";
          publish();
          if (snapshot.targetStatus !== "ready") {
            publish({ status: "ready", canLoadMore: false });
            return;
          }
        }
      }
      if (!rootId) {
        const selected = await reader.read(
          [{ ids: [messageId], "#h": [channelId], limit: 1 }],
          { signal: owned.signal },
        );
        if (!active()) return;
        const event = selected.find(
          (event) =>
            event.id === messageId &&
            contentKind(event) &&
            inChannel(event, channelId),
        );
        if (!event) throw new Error("The selected message is unavailable.");
        rootId = threadReference(event)?.rootId ?? event.id;
      }
      const rootFilter: ReadFilter = {
        ids: [rootId],
        "#h": [channelId],
        limit: 1,
      };
      let root: readonly RelayEvent[] = [];
      if (mode !== "legacy") {
        // Strict requests cannot batch an ID lookup with a window. Admit the
        // verified root first so channel-less root aux has visibility evidence.
        // Revalidate once per run, not once per page of a retained-range repair.
        const rootResponse = await reader.read([rootFilter], {
          signal: owned.signal,
        });
        if (!active()) return;
        root = admit(rootResponse);
        if (!active()) return;
        if (
          !root.some(
            (event) =>
              event.id === rootId &&
              contentKind(event) &&
              inChannel(event, channelId) &&
              !threadReference(event),
          )
        ) {
          rootUnavailable = true;
          rewind();
          publish({ canLoadMore: false, canLoadBack: false });
          throw new Error("The original thread message is unavailable.");
        }
        remote = union(remote, related(root));
      }
      // A strict refresh at the window's newest end re-reads from it. Live
      // replay covers minutes, not a long disconnect, so keep paging until a
      // reply kept across the drop is reached.
      const kept = replace ? (held ?? unverified()) : new Set<string>();
      let reached = !kept.size;
      let more = false;
      for (
        let page = 0;
        page < count ||
        (mode === "older" && !reached && page < MAX_PAGES) ||
        (!!boundary &&
          more &&
          !!nextCursor &&
          order(nextCursor, boundary) < 0 &&
          page < MAX_PAGES);
        page++
      ) {
        const filter: ReadFilter = {
          kinds: [9, 40002, 40008],
          "#h": [channelId],
          "#e": [rootId],
          depth_limit: 100,
          limit: PAGE_SIZE,
          include_aux: true,
        };
        let response: readonly RelayEvent[];
        let bounds: ReturnType<typeof threadBounds> | undefined;
        if (mode !== "legacy") {
          try {
            const page = await reader.read(
              [
                {
                  ...filter,
                  kinds: STRICT_WINDOW_KINDS,
                  limit: nextPages === 0 ? INITIAL_WINDOW_SIZE : PAGE_SIZE,
                  thread_window: true,
                  ...(nextCursor
                    ? { until: nextCursor.created_at, before_id: nextCursor.id }
                    : {}),
                },
              ],
              { signal: owned.signal },
            );
            if (!active()) return;
            const bound = page.find((event) => event.kind === 39007);
            if (!bound) throw new MissingThreadBounds();
            bounds = threadBounds(bound); // Reader already verified signer and full request binding.
            mode = "older";
            response = [
              ...root,
              ...page.filter((event) => event.kind !== 39007),
            ];
          } catch (error) {
            if (!active()) return;
            if (
              !(error instanceof MissingThreadBounds) ||
              !error.legacyRows ||
              mode !== "probe"
            )
              throw error;
            // A 200 without bounds is not support. Probe rows never entered the
            // session; retry from scratch without a reverse cursor or opt-in.
            mode = "legacy";
            nextCursor = undefined;
            nextPages = 0;
            response = await reader.read([rootFilter, filter], {
              signal: owned.signal,
            });
          }
        } else {
          response = await reader.read(
            [
              rootFilter,
              {
                ...filter,
                ...(nextCursor
                  ? {
                      thread_cursor: nextCursor.created_at,
                      thread_cursor_id: nextCursor.id,
                    }
                  : {}),
              },
            ],
            { signal: owned.signal },
          );
        }
        if (!active()) return;
        const events = admit(response);
        if (!active()) return;
        if (
          !events.some(
            (event) =>
              event.id === rootId &&
              contentKind(event) &&
              inChannel(event, channelId) &&
              !threadReference(event),
          )
        ) {
          // Hide unavailable history without throwing away known tombstones.
          rootUnavailable = true;
          rewind();
          publish({ canLoadMore: false, canLoadBack: false });
          throw new Error("The original thread message is unavailable.");
        }
        // Count traversal rows before presentation filtering. The bridge may return
        // other content kinds, and appended auxiliaries do not consume its page limit.
        const replies = events.filter(isReply).sort(compare);
        reached ||= replies.some((event) => kept.has(event.id));
        if (
          !bounds &&
          replies.some((event) => nextCursor && compare(event, nextCursor) <= 0)
        )
          throw new Error(
            "Thread pagination did not advance. Refresh to try again.",
          );
        nextCursor = bounds
          ? (bounds.cursor ?? undefined)
          : (replies.at(-1) ?? nextCursor);
        nextPages++;
        fetched = union(fetched, related(events));
        // Only strict bounds prove exhaustion. Legacy short pages may be filtered
        // after LIMIT, so an empty continuation means merely no more returned.
        more = bounds ? bounds.hasMore : replies.length > 0;
        // A page read again keeps the window's recorded boundary.
        if (kind !== "back") starts[nextPages] = nextCursor;
        if (!more) break;
      }
      if (!active()) return;
      // A bounded response cannot retract observed evidence. Retain known edits,
      // tombstones and live rows even when a later finite read omits them. Replies
      // the re-read never reached sit past a gap it cannot show; those go, with
      // the pages read past the reader's range: as resident pages, every later
      // refresh would re-read them all.
      const unreached = mode === "older" && !reached && more;
      remote = union(
        unreached ? remote.filter((event) => !kept.has(event.id)) : remote,
        fetched,
      );
      rootUnavailable = false;
      if (kind === "back") lo = first;
      else {
        if (kind === "latest") lo = 0;
        pages = unreached ? first + count : nextPages;
        hasMore = more;
        if (!more) starts.length = pages;
      }
      evict();
      shrink(kind === "more" ? "start" : kind === "back" ? "end" : oldest());
      // While the stream is down (a drop mid-refresh ran stale() first) the
      // held replies stand; a view holding none, or a fill that gave them up,
      // takes the replies now.
      if (replace && !dropped) held = undefined;
      else if (replace && (unreached || !held?.size)) held = unverified();
      publish({
        status: "ready",
        error: undefined,
        readKind: undefined,
        direction: mode === "older" ? "older" : "forward",
        ...paging(),
      });
    } catch (error) {
      if (active()) {
        // A failed repair stays visible with Retry; the page queued behind it
        // would clear that error.
        queued = false;
        if (targetStatus === "loading") targetStatus = "error";
        publishStatus({ status: "error", error: String(error) });
      }
    } finally {
      if (controller === owned) {
        staged = [];
        controller = undefined;
        if (again && !disposed) {
          const established = again === "established";
          again = false;
          void run("refresh", established);
        } else if (queued && !disposed) {
          const kind = queued;
          queued = false;
          void run(kind);
        }
      }
    }
  }
  return {
    channelId,
    // Staged verified IDs allow immediate live delete-of-overlay access checks,
    // without publishing the incomplete finite overlay into any shared view.
    event: (id: string) =>
      [...remote, ...staged, ...selectionStaged].find(
        (event) => event.id === id,
      ),
    events: () => [...remote, ...staged, ...selectionStaged],
    receive,
    purge,
    /** The stream dropped: the replies held now are what its establishment
     * refresh must reach. */
    stale() {
      dropped = true;
      held ??= unverified();
      // A queued establishment was for the stream that just dropped.
      if (again === "established") again = "refresh";
    },
    /** The stream is back: refresh, reaching the replies held across the drop. */
    established: () => run("refresh", true),
    localChanged() {
      const next = localOperations();
      if (
        next.length !== localInputs.length ||
        next.some((item, index) => item !== localInputs[index])
      )
        publish();
    },
    /** Profiles change the rows only through an owner the fold looked up. */
    ownersChanged() {
      for (const [pubkey, owner] of owners)
        if (agentOwner?.(pubkey) !== owner) return publish();
    },
    view: {
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      retarget,
      refresh: () => run("refresh"),
      loadMore: () => run("more"),
      loadBack: () => run("back"),
      latest: () => (mode === "older" ? run("latest") : Promise.resolve()),
      dispose() {
        listeners.clear();
        purge(true);
        disposed = true;
      },
    } satisfies ThreadView,
  };
}
