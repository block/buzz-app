import {
  hasUnread,
  unreadLabel as countLabel,
} from "../../features/relay/unread";
import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import styles from "./Channels.module.css";

export function UnreadBadge({
  session,
  channelId,
  dm = false,
  label,
}: {
  session: RelaySession;
  channelId: string;
  dm?: boolean;
  label?: ReactNode;
}) {
  const target = useMemo(
    () => ({ kind: "channel" as const, channelId }),
    [channelId],
  );
  const subscribe = useCallback(
    (listener: () => void) => session.unread.subscribe(target, listener),
    [session, target],
  );
  const get = useCallback(
    () => session.unread.snapshot(target),
    [session, target],
  );
  const subscribeActivity = useCallback(
    (listener: () => void) =>
      session.unread.subscribeActivity(channelId, listener),
    [session, channelId],
  );
  const getActivity = useCallback(
    () => session.unread.activity(channelId),
    [session, channelId],
  );
  const snapshot = useSyncExternalStore(subscribe, get, get);
  const activity = useSyncExternalStore(
    subscribeActivity,
    getActivity,
    getActivity,
  );
  const count = snapshot.unread;
  const manual = snapshot.manual !== "none";
  const unread = manual || (snapshot.unreadVisible ?? hasUnread(count));
  const threadCount = activity.items?.length ?? 0;
  if (!unread && !threadCount && label === undefined) return null;
  const priority =
    dm || (snapshot.attentionVisible ?? hasUnread(snapshot.attention));
  const showUnreadDot = unread && priority && threadCount === 0;
  const unreadLabel = manual
    ? `Marked unread${snapshot.manual === "local-only" ? " on this device only" : ""}`
    : `${snapshot.unreadVisible && !hasUnread(count) ? "Unread messages" : countLabel(count)}${snapshot.freshness === "stale" ? "; may be out of date" : ""}.`;
  const threadLabel = `${threadCount} unread ${threadCount === 1 ? "thread" : "threads"}${activity.freshness === "stale" ? "; may be out of date" : ""}`;
  return (
    <>
      {label !== undefined && (
        <span data-channel-unread-title={unread || undefined}>{label}</span>
      )}
      {unread && (
        <span
          className={styles.unreadState}
          data-channel-unread=""
          data-priority={priority}
          role="img"
          aria-label={unreadLabel}
        />
      )}
      {showUnreadDot && (
        <span
          className={styles.priorityDot}
          data-channel-priority=""
          data-indicator-layer="unread"
          aria-hidden="true"
        />
      )}
      {threadCount > 0 && (
        <span
          className={styles.threadActivityDot}
          data-channel-activity=""
          role="img"
          aria-label={threadLabel}
          title={threadLabel}
        />
      )}
    </>
  );
}
