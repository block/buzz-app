import { useCallback, useMemo, useSyncExternalStore } from "react";
import type {
  ThreadActivityItem,
  UnreadCapability,
} from "../../features/relay/unread";

/** Whether a channel has unread messages, a manual mark or unread threads.
 * `shown` asks what its row shows instead, which opening the channel quiets. */
export function channelHasUnread(
  unread: UnreadCapability,
  channelId: string,
  shown = false,
) {
  const state = unread.snapshot({ kind: "channel", channelId });
  if (state.manual !== "none") return true;
  if (shown && state.row) return state.row.observedCount > 0;
  return (
    (state.observedCount ?? 0) > 0 ||
    (unread.activity(channelId).items?.length ?? 0) > 0
  );
}

/** Channels among `ids` (a JSON id array) with unread messages or threads.
 * `shown` asks what their rows show instead. */
export function useUnreadChannelIds(
  unread: UnreadCapability,
  ids: string,
  shown = false,
) {
  const targets = useMemo(
    () =>
      (JSON.parse(ids) as string[]).map((channelId) => ({
        kind: "channel" as const,
        channelId,
      })),
    [ids],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = targets.flatMap((target) => [
        unread.subscribe(target, listener),
        unread.subscribeActivity(target.channelId, listener),
      ]);
      return () => {
        for (const stop of stops) stop();
      };
    },
    [targets, unread],
  );
  const snapshot = useCallback(
    () =>
      JSON.stringify(
        targets
          .filter((target) => channelHasUnread(unread, target.channelId, shown))
          .map((target) => target.channelId),
      ),
    [targets, unread, shown],
  );
  const unreadIds = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => new Set<string>(JSON.parse(unreadIds)), [unreadIds]);
}

/** The newest unread thread reply of each channel among `targets` (a JSON
 * array of `[id, dm]` pairs) whose unread is only thread replies: no manual
 * mark and no unread message outside the listed threads. A DM shares one read
 * marker across its threads, so it qualifies only with a single unread thread. */
export function useUnreadThreadOnly(unread: UnreadCapability, targets: string) {
  const channels = useMemo(
    () => JSON.parse(targets) as [string, boolean][],
    [targets],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = channels.flatMap(([channelId]) => [
        unread.subscribe({ kind: "channel", channelId }, listener),
        unread.subscribeActivity(channelId, listener),
      ]);
      return () => {
        for (const stop of stops) stop();
      };
    },
    [channels, unread],
  );
  const snapshot = useCallback(
    () =>
      JSON.stringify(
        channels.flatMap(([channelId, dm]) => {
          const items = unread.activity(channelId).items ?? [];
          const state = unread.snapshot({ kind: "channel", channelId });
          const replies = items.reduce(
            (sum, item) => sum + item.unreadCount,
            0,
          );
          return items[0] &&
            (!dm || items.length === 1) &&
            state.manual === "none" &&
            (state.observedCount ?? 0) <= replies
            ? [items[0]]
            : [];
        }),
      ),
    [channels, unread],
  );
  const threads = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(
    () =>
      new Map(
        (JSON.parse(threads) as ThreadActivityItem[]).map((item) => [
          item.channelId,
          item,
        ]),
      ),
    [threads],
  );
}
