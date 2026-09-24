import { useUserStatus } from "./useUserStatus";
import type { RelaySession } from "../relay/session";
import type { UserStatus } from "../relay/user-status";
import { StatusEmoji } from "./StatusEmoji";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import styles from "./Status.module.css";

export function StatusDisplay({
  status,
  session,
  compact = false,
}: {
  status: UserStatus | undefined;
  session: RelaySession;
  compact?: boolean;
}) {
  if (!status || (!status.emoji && !status.text)) return null;
  const label = [status.emoji, status.text].filter(Boolean).join(" ");
  if (!compact)
    return (
      <span className={styles.status}>
        <StatusEmoji value={status.emoji} session={session} />
        <span className={styles.text}>{status.text}</span>
      </span>
    );
  return (
    <Tooltip
      content={
        <span className={styles.tooltipContent}>
          <StatusEmoji value={status.emoji} session={session} />
          {status.text && <span>{status.text}</span>}
        </span>
      }
    >
      <span
        className={styles.status}
        data-compact
        role="img"
        aria-label={label}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Focus exposes the status tooltip without inventing a button action.
        tabIndex={0}
      >
        <StatusEmoji
          decorative
          value={status.emoji || "💬"}
          session={session}
        />
      </span>
    </Tooltip>
  );
}

export function UserStatusDisplay({
  session,
  userId,
  compact = false,
}: {
  session: RelaySession;
  userId: string;
  compact?: boolean;
}) {
  const status = useUserStatus(session.statuses, userId);
  return <StatusDisplay session={session} status={status} compact={compact} />;
}
