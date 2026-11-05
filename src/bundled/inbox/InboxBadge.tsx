import { useSyncExternalStore } from "react";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { hasUnread } from "./InboxRow";
import styles from "./Inbox.module.css";

/** Unread Activity conversations, beside the page's navigation row. */
export function InboxBadge({ relay }: { relay: RelayData }) {
  const { status, session, viewer, scope } = useRelayConnection(relay);
  return status === "ready" && viewer && scope?.endsWith(`:${viewer}`) ? (
    <UnreadCount session={session} />
  ) : null;
}

function UnreadCount({ session }: { session: RelaySession }) {
  const inbox = useSyncExternalStore(
    session.unread.subscribeInbox,
    session.unread.inbox,
    session.unread.inbox,
  );
  const count = inbox.items.filter(hasUnread).length;
  return count ? (
    <span
      className={styles.badge}
      data-navigation-unread=""
      role="img"
      aria-label={`${count} unread ${count === 1 ? "conversation" : "conversations"}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  ) : null;
}
