import type { RelaySession } from "../relay/session";
import { StatusDisplay } from "../user-status/StatusDisplay";
import { useUserStatus } from "../user-status/useUserStatus";
import styles from "./ProfileStatusBubble.module.css";

export function ProfileStatusBubble({
  session,
  pubkey,
  compact = false,
}: {
  session: RelaySession;
  pubkey: string;
  compact?: boolean;
}) {
  const status = useUserStatus(session.statuses, pubkey);
  if (!status?.text && !status?.emoji) return null;
  return (
    <div className={styles.statusBubble}>
      <StatusDisplay
        session={session}
        status={status}
        size={compact ? "caption" : "default"}
      />
    </div>
  );
}
