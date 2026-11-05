import { byteSize } from "./budget";
import type { ChannelQueries } from "./contracts";
import type { RelayEvent, ReadFilter } from "./events";
import type { ReadOptions } from "./reader";

const mentionKinds = [9, 40002];
const cursorOf = (event: RelayEvent) => ({
  until: event.created_at,
  before_id: event.id,
});
const older = (event: RelayEvent, cursor: ReturnType<typeof cursorOf>) =>
  event.created_at < cursor.until ||
  (event.created_at === cursor.until && event.id > cursor.before_id);
export type InboxFeedSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  error?: string | undefined;
  /** Exact addressed targets whose stored edits/deletions are not settled. */
  incomplete: readonly string[];
  /** More history can be scanned; a page need not contain matching Inbox rows. */
  hasOlder?: boolean;
  loadingOlder?: boolean;
}>;
type HistorySource = {
  filter: ReadFilter;
  cursor?: ReturnType<typeof cursorOf> | undefined;
  done: boolean;
};

/** The session owns finite, verified, viewer-addressed history. No new live route,
 * polling, or parallel channel store. Current membership gates completeness targets. */
export function createInboxFeed({
  viewer,
  channels,
  reader,
  addressedRead,
  retainedEvent,
  retainedEditIds,
  notify = (listener) => listener(),
}: {
  viewer: string;
  channels: ChannelQueries;
  /** Only historical admission preserves the existing store instead of resetting at capacity. */
  reader: {
    read(
      filters: readonly ReadFilter[],
      options: ReadOptions & { historical: boolean },
    ): Promise<readonly RelayEvent[]>;
  };
  /** Private lookups in the existing bounded unread evidence owner. */
  retainedEvent: (id: string) => RelayEvent | undefined;
  retainedEditIds: (ids: readonly string[]) => readonly string[];
  /** Verified session admission calls prepare before publishing unread evidence. */
  addressedRead: (
    filter: ReadFilter,
    signal: AbortSignal,
    prepare: (
      events: readonly RelayEvent[],
      raw?: readonly RelayEvent[],
    ) => void,
    historical: boolean,
  ) => Promise<readonly RelayEvent[]>;
  notify?: (listener: () => void) => void;
}) {
  let closed = false;
  let epoch = 0;
  let work: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let requested = false;
  let headCursor: ReturnType<typeof cursorOf> | undefined;
  let history: HistorySource[] | undefined;
  let sourceIndex = 0;
  let snapshot: InboxFeedSnapshot = Object.freeze({
    status: "idle",
    incomplete: [],
  });
  const listeners = new Set<() => void>();
  // Metadata can hide a row without revoking access. Settle its overlays before
  // later ordinary metadata can reveal the retained mention.
  const admitted = (event: RelayEvent, addressedOnly = true) => {
    const addressed = event.tags.some(
      ([name, value]) => name === "p" && value === viewer,
    );
    if (addressedOnly && !addressed) return false;
    const hs = event.tags.filter(([name]) => name === "h");
    return (
      (hs.length === 0 && addressed) ||
      (hs.length === 1 &&
        channels
          .list()
          .channels.some(
            (channel) =>
              channel.id === hs[0]?.[1] &&
              !channel.huddle &&
              !channel.cached &&
              channel.members?.includes(viewer),
          ))
    );
  };
  function project(events: readonly RelayEvent[], addressedOnly = true) {
    return Object.freeze(
      events.filter(
        (event) =>
          mentionKinds.includes(event.kind) && admitted(event, addressedOnly),
      ),
    );
  }
  function publish(patch: Partial<InboxFeedSnapshot>) {
    if (closed) return;
    snapshot = Object.freeze({
      ...snapshot,
      ...patch,
    });
    for (const listener of listeners) notify(listener);
  }
  async function overlays(
    ids: readonly string[],
    kinds: readonly number[],
    signal: AbortSignal,
    historical: boolean,
  ) {
    if (!ids.length) return [];
    const collected: RelayEvent[] = [];
    let cursor: ReturnType<typeof cursorOf> | undefined;
    for (;;) {
      const page = [
        ...(await reader.read(
          [
            {
              kinds,
              "#e": ids,
              limit: 500,
              ...(cursor ?? {}),
            },
          ],
          { signal, historical },
        )),
      ].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
      const previous = cursor;
      if (previous && page.some((event) => !older(event, previous)))
        throw new Error("Inbox message updates did not advance. Retry inbox.");
      collected.push(...page);
      if (collected.length > 2000 || byteSize(collected) > 4 * 1024 * 1024)
        throw new Error(
          "Inbox message updates exceed the read budget. Retry inbox.",
        );
      const last = page.at(-1);
      if (!last) return collected;
      cursor = cursorOf(last);
      // Authorized responses can have short pages. Only empty ends the walk.
    }
  }
  function historySources() {
    const ids = channels
      .list()
      .channels.filter(
        (channel) =>
          !channel.huddle &&
          !channel.cached &&
          !channel.archived &&
          channel.members?.includes(viewer),
      )
      .map((channel) => channel.id)
      .sort();
    const sources: HistorySource[] = [
      {
        filter: { kinds: mentionKinds, "#p": [viewer], limit: 50 },
        cursor: headCursor,
        done: false,
      },
    ];
    for (let i = 0; i < ids.length; i += 128)
      sources.push({
        filter: { kinds: mentionKinds, "#h": ids.slice(i, i + 128), limit: 50 },
        done: false,
      });
    return sources;
  }
  async function request(loadOlder = false) {
    if (closed) return;
    if (work) return work;
    if (!loadOlder) {
      history = undefined;
      headCursor = undefined;
      sourceIndex = 0;
    }
    if (loadOlder && snapshot.hasOlder === false) return;
    if (loadOlder) history ??= historySources();
    const source =
      loadOlder && history
        ? history
            .slice(sourceIndex)
            .concat(history.slice(0, sourceIndex))
            .find((candidate) => !candidate.done)
        : undefined;
    if (loadOlder && !source) {
      publish({ hasOlder: false });
      return;
    }
    requested = true;
    const generation = epoch;
    const owned = new AbortController();
    controller = owned;
    // Do not clear incomplete targets on retry: the new first read can re-admit
    // the old body before its stored overlays are checked again.
    work = (async () => {
      try {
        // Bounded addressed chat history; nonchat and approvals belong elsewhere.
        const mentionFilter: ReadFilter = source
          ? { ...source.filter, ...source.cursor }
          : {
              kinds: mentionKinds,
              "#p": [viewer],
              limit: 50,
            };
        let rawPage: readonly RelayEvent[] = [];
        const mentions = await addressedRead(
          mentionFilter,
          owned.signal,
          (events, raw = events) => {
            if (closed || generation !== epoch || owned.signal.aborted) return;
            rawPage = [...raw]
              .filter((event) => mentionKinds.includes(event.kind))
              .sort(
                (a, b) =>
                  b.created_at - a.created_at || a.id.localeCompare(b.id),
              );
            const cursor = source?.cursor;
            if (cursor && rawPage.some((event) => !older(event, cursor)))
              throw new Error(
                "Inbox history did not advance. Retry loading older messages.",
              );
            const ids = project(events, !loadOlder).map((event) => event.id);
            if (ids.length)
              publish({
                incomplete: Object.freeze([
                  ...new Set([...snapshot.incomplete, ...ids]),
                ]),
              });
          },
          loadOlder,
        );
        if (closed || generation !== epoch) return;
        // Retry older failed targets even when newer addressed rows pushed them
        // beyond the latest page; never clear an unchecked exact ID.
        const targets = [
          ...new Set([
            ...snapshot.incomplete,
            ...project(mentions, !loadOlder).map((event) => event.id),
          ]),
        ];
        const updates = await overlays(
          targets,
          [40003, 5, 9005],
          owned.signal,
          loadOlder,
        );
        const edits = updates.filter((event) => event.kind === 40003);
        await overlays(
          [
            ...new Set([
              ...retainedEditIds(targets),
              ...edits.map((event) => event.id),
            ]),
          ],
          [5, 9005],
          owned.signal,
          loadOlder,
        );
        if (closed || generation !== epoch) return;
        const last = rawPage.at(-1);
        if (source && history) {
          source.done = !last;
          if (last) source.cursor = cursorOf(last);
          sourceIndex = (history.indexOf(source) + 1) % history.length;
        } else if (last) headCursor = cursorOf(last);
        publish({
          status: "ready",
          incomplete: [],
          error: undefined,
          hasOlder: history?.some((candidate) => !candidate.done) ?? true,
          loadingOlder: false,
        });
      } catch (error) {
        if (closed || generation !== epoch || owned.signal.aborted) return;
        publish({
          status: "error",
          loadingOlder: false,
          error:
            error instanceof Error
              ? error.message
              : "Inbox history unavailable",
        });
      }
    })().finally(() => {
      if (controller === owned) {
        controller = undefined;
        work = undefined;
      }
    });
    if (generation === epoch && controller === owned)
      publish({ status: "loading", error: undefined, loadingOlder: loadOlder });
    return work;
  }
  const refresh = () => request();
  function clear(incomplete: readonly string[] = []) {
    epoch++;
    controller?.abort();
    controller = undefined;
    work = undefined;
    history = undefined;
    headCursor = undefined;
    sourceIndex = 0;
    // Previously demanded data recovers explicitly or through reconnect.
    publish({
      status: "idle",
      incomplete,
      error: undefined,
      hasOlder: true,
      loadingOlder: false,
    });
  }
  const retainedIncomplete = () =>
    Object.freeze(snapshot.incomplete.filter((id) => retainedEvent(id)));
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
    loadOlder: () => request(true),
    stale() {
      epoch++;
      controller?.abort();
      controller = undefined;
      work = undefined;
      history = undefined;
      headCursor = undefined;
      sourceIndex = 0;
      publish({
        status: "idle",
        incomplete: retainedIncomplete(),
        error: undefined,
        hasOlder: true,
        loadingOlder: false,
      });
    },
    reconnect() {
      if (requested) void refresh();
    },
    clear: () => clear(),
    purge: () => clear(retainedIncomplete()),
    dispose() {
      closed = true;
      epoch++;
      controller?.abort();
      controller = undefined;
      work = undefined;
      // Retained capabilities expose no retired content; do not notify dead consumers.
      snapshot = Object.freeze({
        status: "idle",
        incomplete: [],
      });
      listeners.clear();
    },
  });
}
