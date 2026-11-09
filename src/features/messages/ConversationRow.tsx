import type { ComponentProps, ReactNode } from "react";
import { CheckIcon } from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import styles from "./ConversationRow.module.css";

/** PROTOTYPE: one row for every conversation list (Solo, Team, Threads,
 * Mentions, DMs). The place always leads; the avatar always says who.
 *
 *   [who]  (icon) place        time | ✓ on hover
 *          latest message      state
 */
export function ConversationRow({
  avatar,
  place,
  placeIcon,
  time,
  sender,
  preview,
  state = "read",
  onMarkRead,
  ...props
}: {
  /** Who: the agent in Solo, the latest poster in Team, the person in DMs. */
  avatar: ReactNode;
  /** Where: the channel, chat or person, or "in #channel" for a thread. */
  place: ReactNode;
  /** A glyph for places a name alone can't describe (threads, private). */
  placeIcon?: ReactNode | undefined;
  time: ReactNode;
  /** Only when the avatar can't say who: "You", for your own message. */
  sender?: ReactNode | undefined;
  preview: ReactNode;
  state?: "read" | "unread" | "working" | undefined;
  /** Offered on unread rows: a checkmark over the time on hover or focus. */
  onMarkRead?: (() => void) | undefined;
} & Omit<
  ComponentProps<typeof NavigationItem>,
  "icon" | "label" | "trailing" | "multiline"
>) {
  const action = state === "unread" && onMarkRead;
  return (
    <div className={styles.frame} data-action={action ? "" : undefined}>
      <NavigationItem
        {...props}
        multiline
        data-conversation-row=""
        data-state={state}
        label={
          <span className={styles.row}>
            <span className={styles.avatar}>{avatar}</span>
            <span className={styles.lines}>
              <span className={styles.line}>
                <span className={styles.title}>
                  {placeIcon && (
                    <span className={styles.placeIcon}>{placeIcon}</span>
                  )}
                  <span className={styles.place}>{place}</span>
                </span>
                <span className={styles.time}>{time}</span>
              </span>
              <span className={styles.line}>
                <span className={styles.preview}>
                  {sender && <span className={styles.sender}>{sender}: </span>}
                  {preview}
                </span>
                <span className={styles.state}>
                  {state === "unread" && (
                    <span
                      className={styles.unreadDot}
                      role="img"
                      aria-label="Unread"
                    />
                  )}
                  {state === "working" && <TypingDots size="small" />}
                </span>
              </span>
            </span>
          </span>
        }
      />
      {action && (
        <span className={styles.action}>
          <IconButton
            size="xs"
            variant="ghost"
            aria-label="Mark as read"
            title="Mark as read"
            onClick={action}
            icon={<CheckIcon size={16} aria-hidden="true" />}
          />
        </span>
      )}
    </div>
  );
}
