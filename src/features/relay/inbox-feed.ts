import { byteSize } from "./budget";
import type { ChannelQueries } from "./contracts";
import type { RelayEvent, ReadFilter } from "./events";
import type { RelayReader } from "./reader";
import type { InboxItem } from "./inbox";
import { threadReference } from "./thread-reference";

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
  /** Exact activity whose later conversation history has been checked. */
  checkedResponses: readonly string[];
}>;

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
  reader: RelayReader;
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
  ) => Promise<readonly RelayEvent[]>;
  notify?: (listener: () => void) => void;
}) {
  let closed = false;
  let epoch = 0;
  let work: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let requested = false;
  let responseCandidates: readonly InboxItem[] = [];
  let snapshot: InboxFeedSnapshot = Object.freeze({
    status: "idle",
    incomplete: [],
    checkedResponses: [],
  });
  const listeners = new Set<() => void>();
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
    });
    for (const listener of listeners) notify(listener);
  }
  async function overlays(
    ids: readonly string[],
    kinds: readonly number[],
    signal: AbortSignal,
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
          { signal },
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
  async function conversation(item: InboxItem, signal: AbortSignal) {
    const retained = item.messageIds.flatMap((id) => retainedEvent(id) ?? []);
    if (!retained.length) return [];
    const rootId =
      item.rootId ??
      retained.map(threadReference).find((reference) => reference)?.rootId ??
      item.messageId;
    if (item.target.kind !== "channel" && !retainedEvent(rootId))
      await reader.read([{ kinds: mentionKinds, ids: [rootId], limit: 1 }], {
        signal,
      });
    const filter: ReadFilter = {
      kinds: mentionKinds,
      "#h": [item.channelId],
      ...(item.target.kind === "channel" ? {} : { "#e": [rootId] }),
      since: Math.min(...retained.map((event) => event.created_at)),
      limit: 500,
    };
    const collected: RelayEvent[] = [];
    let cursor: ReturnType<typeof cursorOf> | undefined;
    for (;;) {
      const page = [
        ...(await addressedRead(
          { ...filter, ...(cursor ?? {}) },
          signal,
          (visible, raw = visible) => {
            if (
              raw.some((event) => !visible.some((row) => row.id === event.id))
            )
              throw new Error(
                "Inbox replies could not be verified for current access. Retry inbox.",
              );
          },
        )),
      ].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
      const previous = cursor;
      if (previous && page.some((event) => !older(event, previous)))
        throw new Error("Inbox replies did not advance. Retry inbox.");
      collected.push(...page);
      if (collected.length > 2000 || byteSize(collected) > 4 * 1024 * 1024)
        throw new Error("Inbox replies exceed the read budget. Retry inbox.");
      const last = page.at(-1);
      if (!last) return collected;
      cursor = cursorOf(last);
    }
  }
  async function refresh(candidates?: readonly InboxItem[]) {
    if (closed) return;
    if (work) return work;
    requested = true;
    const generation = epoch;
    const owned = new AbortController();
    controller = owned;
    // Do not clear incomplete targets on retry: the new first read can re-admit
    // the old body before its stored overlays are checked again.
    work = (async () => {
      try {
        // Bounded addressed chat history; nonchat and approvals belong elsewhere.
        const mentionFilter: ReadFilter = {
          kinds: mentionKinds,
          "#p": [viewer],
          limit: 50,
        };
        const mentions = candidates
          ? []
          : await addressedRead(mentionFilter, owned.signal, (events) => {
              if (closed || generation !== epoch || owned.signal.aborted)
                return;
              const ids = project(events).map((event) => event.id);
              if (ids.length)
                publish({
                  incomplete: Object.freeze([
                    ...new Set([...snapshot.incomplete, ...ids]),
                  ]),
                });
            });
        if (closed || generation !== epoch) return;
        // Retry older failed targets even when newer addressed rows pushed them
        // beyond the latest page; never clear an unchecked exact ID.
        const targets = [
          ...new Set([
            ...snapshot.incomplete,
            ...project(mentions).map((event) => event.id),
          ]),
        ];
        const checked = new Set(candidates ? snapshot.checkedResponses : []);
        for (const item of candidates ?? responseCandidates) {
          const history = await conversation(item, owned.signal);
          for (const id of [
            ...item.messageIds,
            ...history.map((event) => event.id),
          ]) {
            targets.push(id);
            checked.add(id);
          }
        }
        const updates = await overlays(
          [...new Set(targets)],
          [40003, 5, 9005],
          owned.signal,
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
        );
        if (closed || generation !== epoch) return;
        publish({
          status: "ready",
          incomplete: [],
          checkedResponses: Object.freeze(
            [...checked].filter((id) => retainedEvent(id)),
          ),
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
        work = undefined;
      }
    });
    if (generation === epoch && controller === owned)
      publish({ status: "loading", error: undefined });
    return work;
  }
  function clear(incomplete: readonly string[] = []) {
    epoch++;
    controller?.abort();
    controller = undefined;
    work = undefined;
    // Previously demanded data recovers explicitly or through reconnect.
    responseCandidates = [];
    publish({
      status: "idle",
      incomplete,
      checkedResponses: [],
      error: undefined,
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
    refresh: () => refresh(),
    async ensureResponses(items: readonly InboxItem[]): Promise<void> {
      if (closed || snapshot.status === "error") return;
      responseCandidates = items;
      if (work) {
        const generation = epoch;
        await work;
        if (generation !== epoch) return;
        return this.ensureResponses(items);
      }
      const missing = items.filter((item) =>
        item.messageIds.some((id) => !snapshot.checkedResponses.includes(id)),
      );
      if (missing.length) await refresh(missing);
    },
    stale() {
      epoch++;
      controller?.abort();
      controller = undefined;
      work = undefined;
      publish({
        status: "idle",
        incomplete: retainedIncomplete(),
        checkedResponses: [],
        error: undefined,
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
        checkedResponses: [],
      });
      listeners.clear();
    },
  });
}
