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
  ...props
}: {
  avatar: ReactNode;
  sender: ReactNode;
  source: ReactNode;
  /** `null` leaves the time out, as the sidebar's Activity card does. */
  time: ReactNode;
  preview: ReactNode;
  previewId?: string | undefined;
  unread?: boolean;
} & Omit<
  ComponentProps<typeof NavigationItem>,
  "icon" | "label" | "trailing"
>) {
  return (
    <NavigationItem
      // Two lines everywhere, sidebar rows included.
      multiline
      {...props}
      icon={<span className={styles.rowAvatar}>{avatar}</span>}
      label={
        <span className={styles.content} data-unread={unread || undefined}>
          <span className={styles.lines}>
            <span className={styles.heading}>
              <span className={styles.identity}>
                <strong className={`text-label-sm ${styles.sender}`}>
                  {sender}
                </strong>
                <span
                  className={`text-caption ${styles.source}`}
                  data-inbox-source=""
                >
                  {source}
                </span>
              </span>
              {time !== null && (
                <span
                  className={`text-caption text-subtle ${styles.rowDate}`}
                  data-inbox-date=""
                >
                  {time}
                </span>
              )}
            </span>
            <span
              id={previewId}
              className={`text-body ${unread ? "" : "text-subtle"} ${styles.preview}`}
            >
              {preview}
            </span>
          </span>
          {/* The dot sits in the label, centered on both lines, so the
              avatar, the dot and Mark as read share one vertical center. Read
              rows keep the slot, so times stay aligned. */}
          {unread ? (
            <span
              className={styles.unreadSlot}
              role="img"
              aria-label="Unread"
              data-inbox-unread=""
            >
              <span className={styles.unreadDot} />
            </span>
          ) : (
            <span className={styles.unreadSlot} aria-hidden="true" />
          )}
        </span>
      }
    />
  );
}
