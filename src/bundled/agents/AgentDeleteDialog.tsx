import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";

export function AgentDeleteDialog({
  agent,
  control,
  state,
  onClose,
}: {
  agent: AgentView;
  control: AgentControl;
  state: AgentControlState;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const blocked = busy || state.busy || state.status !== "ready";
  const confirm = async () => {
    if (blocked || !control.delete) return;
    setBusy(true);
    setError(undefined);
    try {
      await control.delete(agent.id, agent.revision);
      onClose();
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Could not confirm deletion.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop data-buzz-ui="" className="buzz-dialog-backdrop" />
        <Dialog.Popup
          data-buzz-ui=""
          className="buzz-dialog agent-dialog text-body"
        >
          <header className="buzz-dialog-header">
            <Dialog.Title className="text-heading">
              Delete {agent.name}?
            </Dialog.Title>
          </header>
          <Dialog.Description className="buzz-dialog-description">
            This stops the agent and removes its settings and app credential
            from this device. Its relay identity and past messages remain
            visible. This cannot be undone here.
          </Dialog.Description>
          <div className="buzz-dialog-body">
            {(error || state.error) && (
              <p role="alert">{state.error ?? error}</p>
            )}
            {state.status === "error" && (
              <Button onClick={() => void control.refresh()}>
                Retry status
              </Button>
            )}
            <div className="buzz-dialog-actions">
              <Button onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={blocked}
                loading={busy}
                onClick={() => void confirm()}
              >
                Delete agent
              </Button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
