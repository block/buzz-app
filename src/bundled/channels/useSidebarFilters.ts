import { useCallback, useMemo, useSyncExternalStore } from "react";
import type {
  MentionActivityItem,
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

/** Channels among `ids` (a JSON id array) with unread messages or threads, or
 * with `markedOnly`, just those marked unread by hand.
 * `shown` asks what their rows show instead, while search still leads with
 * every unread conversation. */
export function useUnreadChannelIds(
  unread: UnreadCapability,
  ids: string,
  shown = false,
  /** Only conversations marked unread by hand. */
  markedOnly = false,
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
          .filter((target) =>
            markedOnly
              ? unread.snapshot(target).manual !== "none"
              : channelHasUnread(unread, target.channelId, shown),
          )
          .map((target) => target.channelId),
      ),
    [targets, unread, shown, markedOnly],
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

export type UnreadReason = Readonly<{
  /** The newest unread message that mentions the viewer, top-level or a
   * reply, with a reply's thread (`rootId`). */
  mention?: (MentionActivityItem & { rootId?: string }) | undefined;
  /** The newest thread the viewer is in with unread replies. A thread that
   * counts only for a mention or broadcast is not one. */
  thread?: ThreadActivityItem | undefined;
}>;

/** Why each channel among `ids` (a JSON id array) needs attention beyond its
 * own messages, for channels with an unread mention or thread reply. */
export function useUnreadReasons(unread: UnreadCapability, ids: string) {
  const channels = useMemo(() => JSON.parse(ids) as string[], [ids]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = channels.map((channelId) =>
        unread.subscribeActivity(channelId, listener),
      );
      return () => {
        for (const stop of stops) stop();
      };
    },
    [channels, unread],
  );
  const snapshot = useCallback(
    () =>
      JSON.stringify(
        channels.flatMap((channelId) => {
          const { items, mentions } = unread.activity(channelId);
          const mention = [
            ...(mentions ?? []),
            ...(items ?? []).flatMap(({ mention, rootId }) =>
              mention ? [{ ...mention, rootId }] : [],
            ),
          ].reduce<UnreadReason["mention"]>(
            (newest, item) =>
              !newest ||
              item.createdAt > newest.createdAt ||
              (item.createdAt === newest.createdAt &&
                item.messageId < newest.messageId)
                ? item
                : newest,
            undefined,
          );
          // Items come newest first.
          const thread = items?.find(({ participating }) => participating);
          const reason: UnreadReason = {
            ...(mention ? { mention } : {}),
            ...(thread ? { thread } : {}),
          };
          return reason.mention || reason.thread
            ? [[channelId, reason] as const]
            : [];
        }),
      ),
    [channels, unread],
  );
  const reasons = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(
    () =>
      new Map(JSON.parse(reasons) as [string, UnreadReason][]) as ReadonlyMap<
        string,
        UnreadReason
      >,
    [reasons],
  );
}
