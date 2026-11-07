import { useRef, useState, type RefObject } from "react";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { messagePreview } from "../../features/notifications/content";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Select } from "../../shared/design-system/ui/Select";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import {
  TIME_PRESETS,
  customInputs,
  dueInputs,
  formatDue,
  nextDayAt9am,
  parseCustomDateTime,
  shiftedFrom,
  todayDateString,
} from "./model";
import styles from "./Reminders.module.css";

/** "Remind me" for one message: a preset or custom time, plus an optional note. */
export function RemindDialog({
  message,
  session,
  close,
}: {
  message: ChannelMessage;
  session: RelaySession;
  close(): void;
}) {
  const fields = useRef<HTMLDivElement>(null);
  const [when, setWhen] = useState(TIME_PRESETS[0]?.label ?? "custom");
  const [note, setNote] = useState("");
  const [start] = useState(defaultCustomInputs);
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const notify = useToastNotification();
  const custom = parseCustomDateTime(date, time);
  const preset = TIME_PRESETS.find((item) => item.label === when);
  const submit = async (notBefore: number) => {
    const reminders = session.reminders;
    if (!reminders || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await reminders.create(
        {
          eventId: message.id,
          channelId: message.channelId,
          preview: messagePreview(message.content),
          authorPubkey: message.authorId,
        },
        notBefore,
        note,
      );
      notify(`Reminder set for ${formatDue(notBefore)}`, "success");
      close();
    } catch {
      setError("The reminder could not be saved. Try again.");
      setPending(false);
    }
  };
  return (
    <Dialog
      size="compact"
      open
      dismissOnOutsideClick={false}
      onOpenChange={(open) => !open && close()}
      preventClose={pending}
      initialFocus={fieldFocus(fields, '[role="combobox"]')}
      title="Remind me"
      description="Choose when to be reminded about this message."
      actions={
        <>
          <Button disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={pending}
            disabled={pending || (!preset && custom === null)}
            onClick={() => {
              const at = preset ? preset.at() : parseCustomDateTime(date, time);
              if (at !== null) void submit(at);
            }}
          >
            Set reminder
          </Button>
        </>
      }
    >
      <div ref={fields} className={styles.form}>
        <Select
          label="When"
          variant="field"
          value={when}
          disabled={pending}
          onValueChange={setWhen}
          groups={[
            {
              label: "",
              options: [
                ...TIME_PRESETS.map((item) => ({
                  value: item.label,
                  label: item.label,
                })),
                { value: "custom", label: "Custom date & time" },
              ],
            },
          ]}
        />
        {when === "custom" && (
          <CustomTimeFields
            date={date}
            time={time}
            disabled={pending}
            onDateChange={setDate}
            onTimeChange={setTime}
          />
        )}
        <Field label="Note (optional)">
          <Textarea
            placeholder="What do you want to follow up on?"
            rows={2}
            maxLength={4096}
            value={note}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="text-body text-subtle">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Focus for a reminder dialog's first field. Touch entry focuses the dialog
 * itself, so no keyboard or picker opens before a field is chosen.
 */
function fieldFocus(
  fields: RefObject<HTMLDivElement | null>,
  selector: string,
) {
  return (type: string) =>
    type === "touch" || window.matchMedia?.("(pointer: coarse)").matches
      ? (fields.current?.closest<HTMLElement>('[role="dialog"]') ?? null)
      : (fields.current?.querySelector<HTMLElement>(selector) ?? null);
}

/**
 * Where a custom time starts when there is no due time to keep: the next 9am,
 * today's until it passes, then tomorrow's, so the fields never open on a past
 * time.
 */
function defaultCustomInputs() {
  return customInputs(nextDayAt9am(0));
}

/** Date and time inputs for a custom reminder time, with their notices. */
function CustomTimeFields({
  date,
  time,
  disabled,
  onDateChange,
  onTimeChange,
}: {
  date: string;
  time: string;
  disabled: boolean;
  onDateChange(date: string): void;
  onTimeChange(time: string): void;
}) {
  const custom = parseCustomDateTime(date, time);
  return (
    <>
      <div className={styles.custom}>
        <Field label="Reminder date">
          <Input
            type="date"
            min={todayDateString()}
            value={date}
            disabled={disabled}
            onChange={(event) => onDateChange(event.target.value)}
          />
        </Field>
        <Field label="Reminder time">
          <Input
            type="time"
            value={time}
            disabled={disabled}
            onChange={(event) => onTimeChange(event.target.value)}
          />
        </Field>
      </div>
      {custom === null && (
        <p role="status" className="text-body-sm text-subtle">
          Choose a date and time in the future.
        </p>
      )}
      {custom !== null && shiftedFrom(time, custom) && (
        <p role="status" className="text-body-sm text-subtle">
          That time is skipped by daylight saving. The reminder will be set for{" "}
          {formatDue(custom)}.
        </p>
      )}
    </>
  );
}

/**
 * Snooze's Custom…: moves a reminder to a date and time the person enters,
 * starting from its current due time while that is still ahead, otherwise the
 * next 9am, so an Overdue or Done reminder never opens on a past time. Once
 * the reminder is `cancelled`, the dialog keeps what was typed but won't save.
 */
export function SnoozeDialog({
  title,
  due,
  cancelled,
  save,
  close,
  finalFocus,
}: {
  title: string;
  due: number | undefined;
  cancelled: boolean;
  save(notBefore: number): Promise<unknown>;
  close(): void;
  finalFocus(): HTMLElement | null;
}) {
  const fields = useRef<HTMLDivElement>(null);
  const [start] = useState(() => dueInputs(due) ?? defaultCustomInputs());
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const custom = parseCustomDateTime(date, time);
  const submit = async () => {
    // The clock may have passed the entered time since the last render.
    const at = parseCustomDateTime(date, time);
    if (at === null || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await save(at);
      close();
    } catch {
      setError("The reminder could not be updated. Try again.");
      setPending(false);
    }
  };
  return (
    <Dialog
      size="compact"
      open
      dismissOnOutsideClick={false}
      onOpenChange={(open) => !open && close()}
      preventClose={pending}
      initialFocus={fieldFocus(fields, "input")}
      finalFocus={finalFocus}
      title={title}
      description="Choose when to be reminded."
      actions={
        <>
          <Button disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={pending}
            disabled={pending || cancelled || custom === null}
            onClick={() => void submit()}
          >
            Save
          </Button>
        </>
      }
    >
      <div ref={fields} className={styles.form}>
        <CustomTimeFields
          date={date}
          time={time}
          disabled={pending}
          onDateChange={setDate}
          onTimeChange={setTime}
        />
        {/* A cancelled reminder can't be retried, so its notice replaces any
            save error. */}
        {cancelled ? (
          <p role="status" className="text-body-sm text-subtle">
            This reminder was cancelled.
          </p>
        ) : (
          error && (
            <p role="alert" className="text-body text-subtle">
              {error}
            </p>
          )
        )}
      </div>
    </Dialog>
  );
}
