import { useCallback, useSyncExternalStore } from "react";
import { DotsThreeIcon, QuestionIcon } from "../../shared/design-system/icons";
import type { createRetainedSessions } from "./retained-sessions";
import styles from "./SessionActivity.module.css";

type Evidence = ReturnType<
  ReturnType<typeof createRetainedSessions>["forSession"]
>;

/** Noninteractive owner-only evidence, independent of the personal unread dot. */
export function SessionActivity({
  evidence,
  channelId,
  rootId,
  compact = false,
}: {
  evidence: Evidence;
  channelId: string;
  rootId: string;
  compact?: boolean;
}) {
  const snapshot = useCallback(
    () => evidence.snapshotActivity(channelId, rootId),
    [evidence, channelId, rootId],
  );
  const state = useSyncExternalStore(evidence.subscribe, snapshot, snapshot);
  if (!state) return null;
  const label = `Owner-visible agent activity: ${state === "working" ? "working" : "status unknown"}`;
  return (
    <span
      className={styles.activity}
      data-session-activity={state}
      data-compact={compact || undefined}
      role="img"
      aria-label={label}
      title={label}
    >
      {state === "working" ? (
        <DotsThreeIcon size={16} aria-hidden="true" />
      ) : (
        <QuestionIcon size={16} aria-hidden="true" />
      )}
      <span className={styles.caption}>
        {state === "working" ? "Working" : "Status unknown"}
      </span>
    </span>
  );
}
