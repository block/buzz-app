import { useEffect, useRef, useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";

/** Remove for a relay-only agent. The caller owns the relay steps; this owns
 * confirmation, progress and retry. Leaving the card cancels unstarted steps. */
export function RelayAgentRemove({
  name,
  remove,
}: {
  name: string;
  remove(signal: AbortSignal): Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const run = useRef<AbortController>(undefined);
  useEffect(() => () => run.current?.abort(), []);
  async function start() {
    if (run.current) return;
    const controller = new AbortController();
    run.current = controller;
    setRemoving(true);
    setError("");
    try {
      await remove(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error ? reason.message : "Failed to remove agent.",
        );
    } finally {
      if (run.current === controller) run.current = undefined;
      if (!controller.signal.aborted) setRemoving(false);
    }
  }
  return (
    <>
      <Button
        size="compact"
        variant="destructive"
        loading={removing}
        onClick={() => setConfirming(true)}
      >
        Remove
      </Button>
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      {confirming && (
        <AlertDialog
          title={`Remove ${name}?`}
          description="Removing this agent cleans it up in this community. It does not delete the agent's key."
          onClose={() => setConfirming(false)}
          actions={
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirming(false);
                  void start();
                }}
              >
                Remove agent
              </Button>
            </>
          }
        >
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-body-sm text-secondary">
            <li>Removes the agent from every channel it belongs to.</li>
            <li>Deletes your saved record of this agent in this community.</li>
            <li>
              Archives the agent so it no longer appears in member lists or
              mention suggestions. This needs you to own its profile or
              administer this community.
            </li>
          </ul>
        </AlertDialog>
      )}
    </>
  );
}
