import { useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import type { ScheduledMessage } from "../relay/scheduled-messages";
import {
  PencilSimpleIcon,
  ClockIcon,
  SendIcon,
  DotsThreeVerticalIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import { avatarMedia } from "../../shared/avatar-source";
import { ScheduleMessageDialog } from "./ScheduleMessageDialog";
import { scheduledLabel } from "./schedule-time";
import { matches, preview } from "../drafts-sent/model";
import { cancelScheduledToDraft } from "./scheduled-draft";
import styles from "./ScheduledMessages.module.css";

type Action = {
  item: ScheduledMessage;
  kind: "edit" | "reschedule" | "send" | "delete" | "draft";
  textReadOnly?: boolean;
};
export function ScheduledMessagesList({
  session,
  items,
  loading,
  error,
  refresh,
  onDraft,
  search = "",
}: {
  session: RelaySession;
  items: readonly ScheduledMessage[];
  loading: boolean;
  error?: string | undefined;
  refresh(): void;
  onDraft(): void;
  search?: string;
}) {
  const [action, setAction] = useState<Action>(),
    [content, setContent] = useState(""),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<string>();
  const pending = useRef(false),
    cancel = useRef<HTMLButtonElement>(null);
  const service = session.scheduledMessages,
    profile = session.viewer
      ? session.profiles.snapshot().get(session.viewer)
      : undefined;
  const rows = items
    .filter(
      (item) =>
        item.status !== "sent" &&
        matches(
          preview(item.content, "Attachment"),
          item.destination.name,
          search,
        ),
    )
    .sort((a, b) => a.sendAt - b.sendAt);
  function choose(item: ScheduledMessage, kind: Action["kind"]) {
    setFailure(undefined);
    setContent(item.content);
    try {
      const textReadOnly =
        kind === "edit" &&
        !!service
          ?.event(item.id, item.revision)
          .tags.some(([name]) => name === "p");
      setAction({ item, kind, textReadOnly });
    } catch {
      setFailure("This message changed. Refresh before editing it.");
    }
  }
  async function run(time?: number) {
    if (!action || !service || pending.current) return false;
    pending.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const { item, kind } = action;
      if (kind === "edit" || kind === "reschedule")
        await service.update(item.id, item.revision, {
          destination: item.destination,
          content: kind === "edit" ? content : item.content,
          sendAt: time ?? item.sendAt,
        });
      else if (kind === "send") await service.sendNow(item.id, item.revision);
      else if (kind === "draft") {
        await cancelScheduledToDraft(session, item);
        onDraft();
      } else await service.cancel(item.id, item.revision);
      setAction(undefined);
      refresh();
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
  const mentionEdit = action?.textReadOnly;
  return (
    <>
      {(error || (!action && failure)) && (
        <p role="alert" className={styles.notice}>
          {error ?? failure}{" "}
          <Button size="sm" onClick={refresh}>
            Try again
          </Button>
        </p>
      )}
      {!service ? (
        <EmptyState
          icon={<ClockIcon size={24} />}
          title="Scheduling is unavailable"
          description="This community does not support scheduled delivery yet."
        />
      ) : loading && !items.length ? (
        <p className={styles.notice} role="status">
          Loading scheduled messages…
        </p>
      ) : !rows.length && !error ? (
        <EmptyState
          icon={<ClockIcon size={24} />}
          title={
            search.trim()
              ? `No scheduled messages match “${search.trim()}”.`
              : "No scheduled messages"
          }
          description={
            search.trim()
              ? "Try a different message or conversation name."
              : "Schedule a message from the arrow beside Send. It will wait here until it’s time."
          }
        />
      ) : null}
      <ul className={styles.list} aria-label="Scheduled messages">
        {rows.map((item) => (
          <li key={`${item.id}:${item.revision}`} className={styles.row}>
            <article
              className={styles.heading}
              aria-label={`Scheduled message to ${item.destination.name}`}
            >
              <Avatar
                size="small"
                alt=""
                fallback={profile?.name ?? "You"}
                src={avatarMedia(profile?.picture, session.media)}
              />
              <div className={styles.body}>
                <div className={styles.meta}>
                  <strong className="text-label-sm text-standard">
                    {profile?.name ?? "You"}
                  </strong>
                  <span>
                    to {item.destination.name}
                    {item.destination.threadRootId ? " · Thread" : ""}
                  </span>
                  <time dateTime={new Date(item.sendAt).toISOString()}>
                    Scheduled for {scheduledLabel(item.sendAt)}
                  </time>
                </div>
                <p className={styles.content}>{item.content}</p>
                {item.error && (
                  <p className="text-body-sm text-danger">{item.error}</p>
                )}
              </div>
              <fieldset
                className={styles.actions}
                aria-label={`Actions for message to ${item.destination.name}`}
              >
                <IconButton
                  aria-label="Edit message"
                  title="Edit message"
                  size="sm"
                  icon={<PencilSimpleIcon size={16} />}
                  disabled={busy}
                  onClick={() => choose(item, "edit")}
                />
                <IconButton
                  aria-label="Reschedule message"
                  title="Reschedule"
                  size="sm"
                  icon={<ClockIcon size={16} />}
                  disabled={busy}
                  onClick={() => choose(item, "reschedule")}
                />
                <IconButton
                  aria-label="Send message now"
                  title="Send now"
                  size="sm"
                  icon={<SendIcon size={16} />}
                  disabled={busy}
                  onClick={() => choose(item, "send")}
                />
                <MenuRoot>
                  <MenuTrigger
                    disabled={busy}
                    render={
                      <IconButton
                        aria-label="More message actions"
                        title="More actions"
                        size="sm"
                        icon={<DotsThreeVerticalIcon size={16} />}
                      />
                    }
                  />
                  <MenuPopup align="end">
                    <MenuItem onClick={() => choose(item, "draft")}>
                      Cancel schedule and save to drafts
                    </MenuItem>
                    <MenuItem
                      tone="danger"
                      onClick={() => choose(item, "delete")}
                    >
                      Delete message
                    </MenuItem>
                  </MenuPopup>
                </MenuRoot>
              </fieldset>
            </article>
          </li>
        ))}
      </ul>
      {action?.kind === "reschedule" && (
        <ScheduleMessageDialog
          title="Reschedule message"
          initialTime={action.item.sendAt}
          close={() => setAction(undefined)}
          schedule={run}
          error={failure}
        />
      )}
      {action?.kind === "edit" && (
        <Dialog
          open
          size="default"
          title="Edit scheduled message"
          description={`Scheduled for ${scheduledLabel(action.item.sendAt)}`}
          preventClose={busy}
          dismissOnOutsideClick={false}
          onOpenChange={(open) => {
            if (!open) setAction(undefined);
          }}
          actions={
            <>
              <Button disabled={busy} onClick={() => setAction(undefined)}>
                Cancel
              </Button>
              <Button
                variant="prominent"
                disabled={busy || mentionEdit || !content.trim()}
                onClick={() => void run()}
              >
                {busy ? "Saving…" : "Save changes"}
              </Button>
            </>
          }
        >
          <Field label="Message">
            <Textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              disabled={busy}
              readOnly={mentionEdit}
              autoFocus
            />
          </Field>
          {mentionEdit && (
            <p className="text-body-sm text-muted">
              To edit a message with mention recipients, save it to drafts and
              use the composer. You can still reschedule or send it now.
            </p>
          )}
          {failure && (
            <p role="alert" className="text-body-sm text-danger">
              {failure}
            </p>
          )}
        </Dialog>
      )}
      {action && ["send", "delete", "draft"].includes(action.kind) && (
        <AlertDialog
          title={
            action.kind === "send"
              ? "Send this message now?"
              : action.kind === "draft"
                ? "Move this message to drafts?"
                : "Delete scheduled message?"
          }
          description={
            action.kind === "send"
              ? "It will be sent immediately instead of at the scheduled time."
              : action.kind === "draft"
                ? "It will no longer send automatically. Your message will be saved in Drafts."
                : "This message will be removed from the schedule and will not be sent."
          }
          initialFocus={cancel}
          pending={busy}
          onClose={() => setAction(undefined)}
          actions={
            <>
              <Button
                ref={cancel}
                disabled={busy}
                onClick={() => setAction(undefined)}
              >
                Cancel
              </Button>
              <Button
                variant={action.kind === "delete" ? "destructive" : "prominent"}
                disabled={busy}
                onClick={() => void run()}
              >
                {busy
                  ? "Saving…"
                  : action.kind === "send"
                    ? "Send now"
                    : action.kind === "draft"
                      ? "Save to drafts"
                      : "Delete message"}
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
