import { useRef, useState, useSyncExternalStore } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import type { AgentDeleteRequest, Agents } from "../../features/agents/service";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The owner confirms another agent's request to delete one of their agents.
 * Nothing is deleted until they press Delete. */
export function DeleteReview({ agents }: { agents: Agents }) {
  const requests = useSyncExternalStore(
    agents.subscribe,
    agents.deleteRequests,
  );
  const request = requests[0];
  if (!request) return null;
  return <DeleteConfirm key={request.id} agents={agents} request={request} />;
}

function DeleteConfirm({
  agents,
  request,
}: {
  agents: Agents;
  request: AgentDeleteRequest;
}) {
  const notify = useToastNotification();
  const cancel = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState<string>();
  const [error, setError] = useState("");
  const removing = step !== undefined;
  const several = agents.memberships(request.agent).length > 1;
  const confirm = async () => {
    setStep("Starting");
    setError("");
    try {
      await agents.approveDelete(request.id, setStep);
      notify(`Deleted ${request.agentName}`, "success");
    } catch (reason) {
      setError(message(reason));
      setStep(undefined);
    }
  };
  return (
    <AlertDialog
      title={`Delete ${request.agentName}?`}
      description={`${
        request.requester === request.agent
          ? "It asked to be deleted."
          : `${request.requesterName} asked to delete it.`
      } ${
        several
          ? "It stops in every community it's in. In each one it leaves every channel and is archived so it no longer appears in member lists or mention suggestions, then its key is deleted from this device."
          : "It stops, leaves every channel and is archived so it no longer appears in member lists or mention suggestions, then its key is deleted from this device."
      } It can't be undone.`}
      pending={removing}
      initialFocus={cancel}
      onClose={() => agents.dismissDelete(request.id)}
      actions={
        <>
          <Button
            ref={cancel}
            disabled={removing}
            onClick={() => agents.dismissDelete(request.id)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={removing}
            onClick={() => void confirm()}
          >
            Delete
          </Button>
        </>
      }
    >
      {removing || error ? (
        <>
          {removing && (
            <p role="status" className="m-0 text-body-sm text-secondary">
              {step}…
            </p>
          )}
          {error && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {error}
            </p>
          )}
        </>
      ) : null}
    </AlertDialog>
  );
}
