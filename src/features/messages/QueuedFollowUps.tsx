import { useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { TrashIcon } from "../../shared/design-system/icons";
import { followUpQueue } from "./follow-up-queue";
import styles from "./QueuedFollowUps.module.css";

export function QueuedFollowUps({
  session,
  channelId,
  disabled,
}: {
  session: RelaySession;
  channelId: string;
  disabled: boolean;
}) {
  const queue = followUpQueue(session);
  const entries = useSyncExternalStore(queue.subscribe, queue.snapshot).filter(
    (entry) => entry.channelId === channelId,
  );
  if (!entries.length) return null;
  return (
    <section className={styles.queue} aria-label="Queued follow-ups">
      <ol className={styles.list}>
        {entries.map((entry) => (
          <li key={entry.id} className={styles.row}>
            <div className={styles.content}>
              <p className={styles.preview}>{entry.text || "Attachment"}</p>
              {entry.error && (
                <p role="alert" className="text-body-sm text-danger">
                  {entry.error}
                </p>
              )}
            </div>
            <div className={styles.actions}>
              <IconButton
                data-remove-action
                variant="destructive-quiet"
                shape="inset"
                size="sm"
                aria-label="Remove queued message"
                icon={<TrashIcon size={16} strokeWidth={1.5} />}
                onClick={() => queue.remove(entry.id)}
              />
              <Button
                variant="subtle-muted"
                size="caption"
                disabled={disabled}
                onClick={() => queue.sendNow(entry.id)}
              >
                Send
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
