// Owner actions on an Agents2 agent that every surface showing it offers: the
// Agents2 Build view and the profile panel.
import { useState } from "react";
import { TrashIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import type { Agent, Agents2 } from "./service";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Delete, after a confirmation that says what it does. */
export function AgentDelete({
  agents2,
  agent,
  onRemoved,
}: {
  agents2: Agents2;
  agent: Agent;
  onRemoved(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setRemoving(true);
    setError("");
    try {
      await agents2.remove(agent.pubkey);
      setConfirming(false);
      onRemoved();
    } catch (reason) {
      setError(message(reason));
      setRemoving(false);
    }
  };
  return (
    <>
      <Button
        size="compact"
        variant="ghost"
        onClick={() => setConfirming(true)}
      >
        <TrashIcon size={14} aria-hidden="true" /> Delete agent
      </Button>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${agent.name}?`}
        description="This removes it from every channel, archives it so it no longer appears in member lists or mention suggestions, and deletes its key from this device. It can't be undone."
        preventClose={removing}
        actions={
          <>
            <Button onClick={() => setConfirming(false)} disabled={removing}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={removing}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          </>
        }
      >
        {error ? (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}

/** Shown while the agent's name has not reached the relay, with a Retry. */
export function AgentProfilePending({
  agents2,
  agent,
}: {
  agents2: Agents2;
  agent: Agent;
}) {
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  if (!agent.profilePending) return null;
  const retry = async () => {
    setPublishing(true);
    setError("");
    try {
      await agents2.publishProfile(agent.pubkey);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPublishing(false);
    }
  };
  return (
    <div role="status" className="flex flex-col items-start gap-1">
      <p className="m-0 text-body-sm text-secondary">
        Its name isn't published yet, so others may see it unnamed or by an
        older name.
      </p>
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
      <Button size="compact" loading={publishing} onClick={() => void retry()}>
        Retry publishing
      </Button>
    </div>
  );
}
