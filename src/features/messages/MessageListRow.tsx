import type { ComponentProps, ReactNode } from "react";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import styles from "./MessageListRow.module.css";

/** Activity's message-row composition, also used for your drafts and sent messages.
 * Reading, draft continuation and delivery evidence stay with each caller. */
export function MessageListRow({
  avatar,
  sender,
  source,
  time,
  preview,
  previewId,
  unread = false,
  status,
  ...props
}: {
  avatar: ReactNode;
  sender: ReactNode;
  source: ReactNode;
  time: ReactNode;
  preview: string;
  previewId?: string | undefined;
  unread?: boolean;
  /** A quiet row-owned indicator after the source, beside the unread dot. */
  status?: ReactNode;
} & Omit<
  ComponentProps<typeof NavigationItem>,
  "icon" | "label" | "trailing"
>) {
  return (
    <NavigationItem
      {...props}
      icon={<span className={styles.rowAvatar}>{avatar}</span>}
      label={
        <span className={styles.content}>
          <span className={styles.heading}>
            <span className={styles.identity}>
              <strong
                className={`text-label-sm text-standard ${styles.sender}`}
              >
                {sender}
              </strong>
              <span
                className={`text-caption ${styles.source}`}
                data-inbox-source=""
              >
                {source}
              </span>
              {status}
            </span>
            <span
              className={`text-caption text-subtle ${styles.rowDate}`}
              data-inbox-date=""
            >
              {time}
            </span>
          </span>
          <span
            id={previewId}
            data-inbox-preview=""
            className={`text-body ${unread ? "text-standard" : "text-subtle"} ${styles.preview}`}
          >
            {preview}
          </span>
        </span>
      }
      trailing={
        unread ? (
          <span className={styles.unreadSlot} role="img" aria-label="Unread">
            <span className={styles.unreadDot} />
          </span>
        ) : (
          <span className={styles.unreadSlot} aria-hidden="true" />
        )
      }
    />
  );
}
