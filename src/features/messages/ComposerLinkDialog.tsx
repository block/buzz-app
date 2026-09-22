import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";

export function ComposerLinkDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onSubmit(link: { label: string; url: string }): boolean;
}) {
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
              if (!url.trim()) return;
              if (
                !onSubmit({
                  label: label.trim() || url.trim(),
                  url: url.trim(),
                })
              )
                return;
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
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <div className="composer-link-actions">
              <BaseDialog.Close
                render={<Button variant="ghost">Cancel</Button>}
              />
              <Button type="submit" variant="primary">
                Add link
              </Button>
            </div>
          </form>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
