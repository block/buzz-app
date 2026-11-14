import { useId, useRef, useState } from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { ScheduleDateTime } from "./ScheduleDateTime";
import { scheduleError } from "./schedule-time";
export { localScheduleTime, parseScheduleTime } from "./schedule-time";

export function ScheduleMessageDialog({
  close,
  schedule,
  error,
  initialTime,
  title = "Schedule message",
}: {
  close(): void;
  schedule(time: number): Promise<boolean | undefined>;
  error?: string | undefined;
  initialTime?: number;
  title?: string;
}) {
  const [time, setTime] = useState(
    () => initialTime ?? Math.ceil((Date.now() + 60_000) / 900_000) * 900_000,
  );
  const [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false);
  const pending = useRef(false),
    form = useId();
  const invalid = scheduleError(time);
  const timezone =
    new Intl.DateTimeFormat(undefined, { timeZoneName: "longGeneric" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  async function submit() {
    if (scheduleError(time) || pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      if (await schedule(time)) close();
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      size="default"
      title={title}
      description={`Time zone: ${timezone}`}
      preventClose={busy}
      dismissOnOutsideClick={false}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      actions={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            type="submit"
            form={form}
            disabled={busy || !!invalid}
          >
            {busy
              ? "Scheduling…"
              : title === "Reschedule message"
                ? "Save changes"
                : "Schedule message"}
          </Button>
        </>
      }
    >
      <form
        id={form}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void submit();
        }}
      >
        <ScheduleDateTime value={time} onChange={setTime} disabled={busy} />
        {invalid && (
          <p role="alert" className="text-body-sm text-danger">
            {invalid}
          </p>
        )}
        {failed && (
          <p role="alert" className="text-body-sm text-danger">
            {error ||
              "Could not schedule this message. Your draft is still here."}
          </p>
        )}
      </form>
    </Dialog>
  );
}
