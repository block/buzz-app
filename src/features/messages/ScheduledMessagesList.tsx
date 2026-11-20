import { useRef, useState } from "react";
import { ClockIcon, TrashIcon } from "../../shared/design-system/icons";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import type {
  ScheduledMessage,
  ScheduledMessages,
} from "../relay/scheduled-messages";
import { ScheduleMessageDialog } from "./ScheduleMessageDialog";
import { scheduledLabel } from "./schedule-time";
import styles from "./ScheduledMessages.module.css";

type Action = { item: ScheduledMessage; kind: "reschedule" | "cancel" };

export function ScheduledMessagesList({
  service,
  items,
  loading,
  error,
  refresh,
}: {
  service: ScheduledMessages;
  items: readonly ScheduledMessage[];
  loading: boolean;
  error?: string | undefined;
  refresh(): void;
}) {
  const [action, setAction] = useState<Action>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const pending = useRef(false);
  const keep = useRef<HTMLButtonElement>(null);
  const rows = items
    .filter((item) => item.status !== "sent")
    .sort((a, b) => a.sendAt - b.sendAt);

  function choose(item: ScheduledMessage, kind: Action["kind"]) {
    setFailure(undefined);
    setAction({ item, kind });
  }

  async function run(action: Action, time?: number) {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const { item } = action;
      if (time === undefined) await service.cancel(item.id, item.revision);
      else
        await service.update(item.id, item.revision, {
          destination: item.destination,
          content: item.content,
          sendAt: time,
        });
      setAction(undefined);
      return true;
    } catch (cause) {
      setFailure(
        cause instanceof Error
          ? cause.message
          : "Could not update this message.",
      );
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      {error && (
        <p role="alert" className={styles.notice}>
          {error}{" "}
          <Button size="sm" onClick={refresh}>
            Try again
          </Button>
        </p>
      )}
      {loading && !rows.length ? (
        <p className={styles.notice} role="status">
          Loading scheduled messages…
        </p>
      ) : !rows.length && !error ? (
        <EmptyState
          icon={<ClockIcon size={24} />}
          title="No scheduled messages"
          description="Use the arrow beside Send to schedule a message."
        />
      ) : null}
      {rows.length > 0 && (
        <ul className={styles.list} aria-label="Scheduled messages">
          {rows.map((item) => (
            <li key={item.id} className={styles.row}>
              <div className={styles.body}>
                <div className={styles.meta}>
                  <strong className="text-label-sm text-standard">
                    {item.destination.name}
                    {item.destination.threadRootId ? " · Thread" : ""}
                  </strong>
                  <time dateTime={new Date(item.sendAt).toISOString()}>
                    {scheduledLabel(item.sendAt)}
                  </time>
                </div>
                <p className={styles.content}>{item.content || "Attachment"}</p>
                {item.status === "failed" && (
                  <p className="text-body-sm text-danger">
                    {item.error ?? "Delivery failed."}
                  </p>
                )}
              </div>
              <div className={styles.actions}>
                <IconButton
                  aria-label="Reschedule message"
                  title="Reschedule"
                  size="sm"
                  icon={<ClockIcon size={16} />}
                  disabled={busy}
                  onClick={() => choose(item, "reschedule")}
                />
                <IconButton
                  aria-label="Cancel scheduled message"
                  title="Cancel scheduled message"
                  size="sm"
                  icon={<TrashIcon size={16} />}
                  disabled={busy}
                  onClick={() => choose(item, "cancel")}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {action?.kind === "reschedule" && (
        <ScheduleMessageDialog
          title="Reschedule message"
          initialTime={action.item.sendAt}
          close={() => setAction(undefined)}
          schedule={(time) => run(action, time)}
          error={failure}
        />
      )}
      {action?.kind === "cancel" && (
        <AlertDialog
          title="Cancel this scheduled message?"
          description="This removes the message from the queue."
          initialFocus={keep}
          pending={busy}
          onClose={() => setAction(undefined)}
          actions={
            <>
              <Button
                ref={keep}
                disabled={busy}
                onClick={() => setAction(undefined)}
              >
                Keep scheduled
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => void run(action)}
              >
                {busy ? "Cancelling…" : "Cancel message"}
              </Button>
            </>
          }
        >
          {failure && (
            <p role="alert" className="text-body-sm text-danger">
              {failure}
            </p>
          )}
        </AlertDialog>
      )}
    </>
  );
}
