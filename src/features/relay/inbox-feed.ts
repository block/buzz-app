import type { ChannelQueries } from "./contracts";
import type { RelayEvent, ReadFilter } from "./events";
import type { RelayReader } from "./reader";

const mentionKinds = [9, 40002];
const union = (
  old: readonly RelayEvent[],
  next: readonly RelayEvent[],
  cap: number,
) =>
  [...new Map([...old, ...next].map((event) => [event.id, event])).values()]
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    .slice(0, cap);
const deletedBy = (event: RelayEvent, deletions: readonly RelayEvent[]) =>
  deletions.some(
    (deletion) =>
      deletion.pubkey === event.pubkey &&
      deletion.tags.some(([name, id]) => name === "e" && id === event.id),
  );
export type InboxFeedSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  mentions: readonly RelayEvent[];
  error?: string | undefined;
  /** Finite reads are bounded, not a claim of complete historical coverage. */
  limited: boolean;
}>;

/** The session owns finite, verified, viewer-addressed history. No new live route,
 * polling, or parallel channel store. Current membership is checked at projection. */
export function createInboxFeed({
  viewer,
  channels,
  reader,
  notify = (listener) => listener(),
}: {
  viewer: string;
  channels: ChannelQueries;
  reader: RelayReader;
  notify?: (listener: () => void) => void;
}) {
  let closed = false;
  let epoch = 0;
  let work: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let requested = false;
  // Only arrivals during this finite attempt; never a persistent second cache.
  let arrivals:
    | {
        mentions: readonly RelayEvent[];
        deletions: readonly RelayEvent[];
      }
    | undefined;
  let rawMentions: readonly RelayEvent[] = [];
  let snapshot: InboxFeedSnapshot = Object.freeze({
    status: "idle",
    mentions: [],
    limited: false,
  });
  const listeners = new Set<() => void>();
  const stopChannels = channels.subscribeList(() => {
    if (rawMentions.length) publish({});
  });
  const admitted = (event: RelayEvent) => {
    if (!event.tags.some(([name, value]) => name === "p" && value === viewer))
      return false;
    const hs = event.tags.filter(([name]) => name === "h");
    return (
      hs.length === 0 ||
      (hs.length === 1 &&
        channels
          .list()
          .channels.some(
            (channel) =>
              channel.id === hs[0]?.[1] &&
              !channel.cached &&
              channel.members?.includes(viewer),
          ))
    );
  };
  function project(events: readonly RelayEvent[]) {
    return Object.freeze(
      events.filter(
        (event) => mentionKinds.includes(event.kind) && admitted(event),
      ),
    );
  }
  function publish(patch: Partial<InboxFeedSnapshot>) {
    if (closed) return;
    snapshot = Object.freeze({
      ...snapshot,
      ...patch,
      mentions: project(rawMentions),
    });
    for (const listener of listeners) notify(listener);
  }
  async function refresh() {
    if (closed) return;
    if (work) return work;
    requested = true;
    const generation = epoch;
    const owned = new AbortController();
    controller = owned;
    const delta = {
      mentions: [] as readonly RelayEvent[],
      deletions: [] as readonly RelayEvent[],
    };
    arrivals = delta;
    publish({ status: "loading", error: undefined });
    work = (async () => {
      try {
        // Bounded addressed chat history; nonchat and approvals belong elsewhere.
        const mentionFilter: ReadFilter = {
          kinds: mentionKinds,
          "#p": [viewer],
          limit: 50,
        };
        const mentions = await reader.read([mentionFilter], {
          signal: owned.signal,
        });
        if (closed || generation !== epoch) return;
        rawMentions = union(mentions, delta.mentions, 50).filter(
          (event) => !deletedBy(event, delta.deletions),
        );
        publish({
          status: "ready",
          limited: mentions.length >= 50,
          error: undefined,
        });
      } catch (error) {
        if (closed || generation !== epoch || owned.signal.aborted) return;
        publish({
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Inbox history unavailable",
        });
      }
    })().finally(() => {
      if (controller === owned) {
        controller = undefined;
        arrivals = undefined;
        work = undefined;
      }
    });
    return work;
  }
  return Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure: () =>
      work ?? (snapshot.status === "idle" ? refresh() : Promise.resolve()),
    refresh,
    stale() {
      epoch++;
      controller?.abort();
      controller = undefined;
      work = undefined;
      arrivals = undefined;
      publish({ status: "idle", error: undefined });
    },
    reconnect() {
      if (requested) void refresh();
    },
    receive(events: readonly RelayEvent[]) {
      if (closed || snapshot.status === "idle") return;
      const mentions = project(events);
      const deletions = events.filter(
        (event) => event.kind === 5 || event.kind === 9005,
      );
      if (!mentions.length && !deletions.length) return;
      if (arrivals) {
        arrivals.mentions = union(arrivals.mentions, mentions, 50);
        const merged = union(arrivals.deletions, deletions, 71);
        if (merged.length > 70) {
          // Cannot safely reconcile a bounded attempt after excessive deletion traffic.
          epoch++;
          controller?.abort();
          controller = undefined;
          work = undefined;
          arrivals = undefined;
          rawMentions = [];
          publish({
            status: "error",
            error: "Inbox changed during refresh. Try again.",
          });
          return;
        }
        arrivals.deletions = merged;
      }
      const removed = arrivals?.deletions ?? deletions;
      rawMentions = union(rawMentions, mentions, 50).filter(
        (event) => !deletedBy(event, removed),
      );
      publish({});
    },
    clear() {
      epoch++;
      controller?.abort();
      controller = undefined;
      work = undefined;
      arrivals = undefined;
      rawMentions = [];
      // Preserve never-requested demand. Previously loaded data recovers explicitly
      // through Refresh (or the existing reconnect callback), not a new retry loop.
      publish({ status: "idle", limited: false, error: undefined });
    },
    dispose() {
      closed = true;
      epoch++;
      controller?.abort();
      controller = undefined;
      work = undefined;
      arrivals = undefined;
      rawMentions = [];
      // Retained capabilities expose no retired content; do not notify dead consumers.
      snapshot = Object.freeze({
        status: "idle",
        mentions: [],
        limited: false,
      });
      stopChannels();
      listeners.clear();
    },
  });
}
