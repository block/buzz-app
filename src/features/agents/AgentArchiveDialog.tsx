import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";

/** Archive confirmation shared by agent surfaces. Archive changes visibility
 * only; the copy keeps it distinct from Remove and Delete. */
export function AgentArchiveDialog({
  name,
  community,
  running,
  onCancel,
  onConfirm,
}: {
  name: string;
  community: string;
  running: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <AlertDialog
      title={`Archive ${name}?`}
      description={`This hides ${name} from search, mentions, and Add member in ${community}. It won’t remove the agent from its channels or delete its saved setup. You can unarchive it later.`}
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="prominent" onClick={onConfirm}>
            Archive agent
          </Button>
        </>
      }
    >
      {running && (
        <p className="m-0 text-body-sm text-secondary">
          This agent is running. Archiving won’t stop it.
        </p>
      )}
    </AlertDialog>
  );
}
