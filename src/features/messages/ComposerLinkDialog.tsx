import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useId, useState } from "react";
import { isSupportedMessageLink } from "./message-link-parts";
import { Button } from "../../shared/design-system/ui/Button";

export function ComposerLinkDialog({
  open,
  disabled,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  disabled: boolean;
  onOpenChange(open: boolean): void;
  onSubmit(link: { label: string; url: string }): boolean;
}) {
  const errorId = useId();
  const [error, setError] = useState<string>();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="composer-link-backdrop" />
        <BaseDialog.Popup className="composer-link-dialog">
          <BaseDialog.Title className="text-heading text-primary">
            Add link
          </BaseDialog.Title>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled) return;
              if (!isSupportedMessageLink(url.trim())) {
                setError(
                  "Use an HTTPS address without credentials or a valid Buzz link.",
                );
                return;
              }
              if (
                !onSubmit({
                  label: label.trim() || url.trim(),
                  url: url.trim(),
                })
              ) {
                setError(
                  "The link could not be added. Check the draft is editable and within its limit.",
                );
                return;
              }
              setError(undefined);
              setLabel("");
              setUrl("");
              onOpenChange(false);
            }}
          >
            <label className="text-body text-primary">
              Link text
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label className="text-body text-primary">
              Address
              <input
                required
                aria-invalid={!!error}
                aria-describedby={error ? errorId : undefined}
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setError(undefined);
                }}
              />
            </label>
            {error && (
              <p id={errorId} role="alert">
                {error}
              </p>
            )}
            <div className="composer-link-actions">
              <BaseDialog.Close
                render={<Button variant="ghost">Cancel</Button>}
              />
              <Button type="submit" variant="primary" disabled={disabled}>
                Add link
              </Button>
            </div>
          </form>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
