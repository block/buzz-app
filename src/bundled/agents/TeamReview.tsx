import { useId, useState, useSyncExternalStore } from "react";
import type { Agents, TeamRequest } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { TeamFields, type TeamDraft } from "./TeamFields";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The owner reviews another agent's team request in the Teams form. */
export function TeamReview({ agents }: { agents: Agents }) {
  const requests = useSyncExternalStore(agents.subscribe, agents.teamRequests);
  const request = requests[0];
  return request ? (
    <Review key={request.id} agents={agents} request={request} />
  ) : null;
}

function Review({ agents, request }: { agents: Agents; request: TeamRequest }) {
  const { running } = useSyncExternalStore(agents.subscribe, agents.snapshot);
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState<TeamDraft>({
    name: request.name,
    instructions: request.instructions,
    members: request.members,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // What a synced Save revises, and a new team's id for every retry.
  const [opened] = useState(() =>
    agents.snapshot().teams.find((team) => team.id === request.team),
  );
  const [created] = useState(() => crypto.randomUUID());
  const form = useId();
  // Members not in this community, which it doesn't list but keeps.
  const away = draft.members.filter(
    (pubkey) =>
      !running.some((agent) => agent.pubkey === pubkey) &&
      agents.memberships(pubkey).length > 0,
  ).length;
  const save = async () => {
    if (pending || !draft.name.trim()) return;
    setPending(true);
    setError("");
    try {
      await agents.approveTeam(request.id, {
        ...draft,
        name: draft.name.trim(),
        ...(opened ? { opened } : { draft: created }),
      });
      setOpen(false);
    } catch (reason) {
      setError(message(reason));
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) setOpen(false);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) agents.dismissTeam(request.id);
      }}
      title={request.team ? `Edit ${draft.name || "team"}` : "New team"}
      description={`${request.requesterName} ${request.team ? "proposed these changes" : "requested this team"}. Nothing is saved until you save.`}
      size="default"
      height="content"
      chromeSpacing="padded"
      preventClose={pending}
      actions={
        <Button
          variant="primary"
          type="submit"
          form={form}
          loading={pending}
          disabled={!draft.name.trim()}
        >
          {request.team ? "Save team" : "Create team"}
        </Button>
      }
    >
      <form
        id={form}
        className="grid gap-4"
        aria-label={request.team ? `Edit ${request.name}` : "New team"}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <TeamFields
          value={draft}
          agents={running}
          disabled={pending}
          autoFocus
          away={away}
          onChange={(next) => {
            setDraft(next);
            setError("");
          }}
        />
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
