import { useState, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import type {
  Agents,
  TeamCreationRequest,
} from "../../features/agents/service";

/** The owner reviews an agent's proposed new team, one request at a time,
 * and creates only what they reviewed. Members are shown, not edited here. */
export function TeamCreationReview({ agents }: { agents: Agents }) {
  const [request] = useSyncExternalStore(
    agents.subscribe,
    agents.teamCreationRequests,
  );
  return request ? (
    <TeamCreationDialog key={request.id} agents={agents} request={request} />
  ) : null;
}

function TeamCreationDialog({
  agents,
  request,
}: {
  agents: Agents;
  request: TeamCreationRequest;
}) {
  const [name, setName] = useState(request.name);
  const [instructions, setInstructions] = useState(request.instructions);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setPending(true);
    setError("");
    try {
      await agents.approveTeamCreation(request.id, {
        name: name.trim(),
        instructions,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) agents.dismissTeamCreation(request.id);
      }}
      title="Create a new team"
      description={`${request.requesterName} proposed this team. Nothing is created until you save.`}
      height="content"
      chromeSpacing="padded"
      actions={
        <Button
          variant="primary"
          loading={pending}
          disabled={!name.trim()}
          onClick={() => void save()}
        >
          Save
        </Button>
      }
    >
      <div className="grid gap-4">
        <Field label="Name">
          <Input
            value={name}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Instructions">
          <Textarea
            rows={8}
            value={instructions}
            disabled={pending}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Field>
        <Field label="Members">
          {request.members.length ? (
            <ul className="m-0 grid gap-1 pl-4 text-body-sm">
              {request.members.map((member) => (
                <li key={member.pubkey}>{member.name}</li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-body-sm text-secondary">No members yet</p>
          )}
        </Field>
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
