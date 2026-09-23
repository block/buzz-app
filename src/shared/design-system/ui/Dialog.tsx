import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { XIcon } from "../icons";
import { useState, type ComponentProps, type ReactNode } from "react";
import { IconButton } from "./IconButton";

type PopupProps = ComponentProps<typeof BaseDialog.Popup>;
export type DialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  closeLabel?: string;
  /** Keep frequent surfaces such as search palettes immediate. */
  motion?: "default" | "none";
  /** A pending operation can prevent all user dismissal paths. */
  preventClose?: boolean;
  initialFocus?: PopupProps["initialFocus"];
  finalFocus?: PopupProps["finalFocus"];
};

/** Base UI owns the modal, portal, focus trap, Escape and focus restoration. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  closeLabel = "Close",
  preventClose = false,
  motion = "default",
  initialFocus,
  finalFocus,
}: DialogProps) {
  const [instantClose, setInstantClose] = useState(false);
  const transition =
    motion === "none" || (!open && instantClose) ? "none" : "default";
  return (
    <BaseDialog.Root
      open={open}
      disablePointerDismissal
      onOpenChange={(next, details) => {
        if (!next && preventClose) {
          details.cancel();
          return;
        }
        setInstantClose(details.reason === "escape-key");
        onOpenChange(next);
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          data-buzz-ui=""
          data-motion={transition}
          className="buzz-dialog-backdrop"
        />
        <BaseDialog.Popup
          data-buzz-ui=""
          className="buzz-dialog gap-0"
          data-motion={transition}
          aria-modal="true"
          initialFocus={initialFocus}
          finalFocus={finalFocus}
        >
          <header className="buzz-dialog-header">
            <div className="buzz-dialog-heading">
              <BaseDialog.Title className="text-label">
                {title}
              </BaseDialog.Title>
              {description && (
                <BaseDialog.Description className="buzz-dialog-description">
                  {description}
                </BaseDialog.Description>
              )}
            </div>
            <BaseDialog.Close
              disabled={preventClose}
              render={
                <IconButton
                  aria-label={closeLabel}
                  disabled={preventClose}
                  size="compact"
                  icon={<XIcon size={16} aria-hidden="true" />}
                />
              }
            />
          </header>
          <div className="buzz-dialog-body buzz-dialog-content">{children}</div>
          {actions && (
            <footer className="buzz-dialog-actions">{actions}</footer>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
