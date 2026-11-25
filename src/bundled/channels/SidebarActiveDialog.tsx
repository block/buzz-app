import { useId, useState, type RefObject } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import {
  DEFAULT_ACTIVE_WINDOW_SECONDS,
  MAX_ACTIVE_WINDOW_SECONDS,
} from "../../features/relay/sidebar-preferences";

const MAX_DAYS = MAX_ACTIVE_WINDOW_SECONDS / 86400;

/**
 * A custom "active in the last N days" window. The draft stays local until
 * Apply; a failed save keeps the entered value and shows why.
 */
export function SidebarActiveDialog({
  seconds = DEFAULT_ACTIVE_WINDOW_SECONDS,
  apply,
  close,
  finalFocus,
}: {
  seconds?: number | undefined;
  apply: (seconds: number) => unknown;
  close: () => void;
  finalFocus: RefObject<HTMLButtonElement | null>;
}) {
  const formId = useId();
  const [draft, setDraft] = useState(String(seconds / 86400));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const days = Number(draft);
  const valid = Number.isInteger(days) && days >= 1 && days <= MAX_DAYS;
  const submit = async () => {
    if (pending) return;
    if (!valid) {
      setError(`Enter a whole number of days from 1 to ${MAX_DAYS}.`);
      return;
    }
    setPending(true);
    setError("");
    try {
      await apply(days * 86400);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      size="compact"
      open
      title="Active in the last"
      footerGap="compact"
      onOpenChange={(open) => !open && close()}
      preventClose={pending}
      finalFocus={finalFocus}
      actions={
        <>
          <Button disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="prominent"
            loading={pending}
          >
            Apply
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Days" error={error || undefined}>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_DAYS}
            step={1}
            value={draft}
            autoFocus
            disabled={pending}
            onFocus={(event) => event.currentTarget.select()}
            onValueChange={(next) => {
              setDraft(next);
              setError("");
            }}
          />
        </Field>
        {pending && (
          <p role="status" className="sr-only">
            Saving filter and waiting for confirmation…
          </p>
        )}
      </form>
    </Dialog>
  );
}
