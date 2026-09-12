import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "../../shared/design-system/ui/Button";

export function ConfirmAction({
  title,
  description,
  action,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  action: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="workflow-dialog-backdrop" />
        <AlertDialog.Popup
          data-buzz-ui=""
          className="workflow-dialog text-body"
        >
          <AlertDialog.Title className="text-heading">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-secondary">
            {description}
          </AlertDialog.Description>
          <div className="workflow-toolbar">
            <Button onClick={onCancel}>Keep editing</Button>
            <Button variant="primary" onClick={onConfirm}>
              {action}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
