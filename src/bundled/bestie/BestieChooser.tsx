import { useState } from "react";
import type { Agents } from "../../features/agents/service";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useAgents } from "../../features/agents/react";
import type { RelaySession } from "../../features/relay/session";
import { chooseDefaultAgent } from "../../features/solo/default-agent";
import { BestieIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Select } from "../../shared/design-system/ui/Select";
import { AgentCreateDialog } from "../agents/AgentCreateDialog";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** The one Bestie selection owner, shared by first setup and stale-choice recovery. */
export function BestieChooser({
  session,
  scope,
  community,
  agents,
  title = "Choose your Bestie",
  description = "Choose an eligible agent, or create one to make your Bestie in Buzz.",
}: {
  session: RelaySession;
  scope: string;
  community?: string | undefined;
  agents: Agents;
  title?: string;
  description?: string;
}) {
  const choices = useAgentChoices(session, true, true);
  const { types } = useAgents(agents);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState("");
  const [created, setCreated] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const choose = async (pubkey: string, keepsCreated = false) => {
    if (saving) return;
    if (!keepsCreated) setCreated("");
    if (
      !session.agentChoices
        .snapshot()
        .selectable.some((agent) => agent.pubkey === pubkey)
    ) {
      setSelected("");
      setError("That agent is no longer available. Choose another.");
      return;
    }
    setSelected(pubkey);
    setSaving(true);
    setError("");
    try {
      await chooseDefaultAgent(session, scope, pubkey);
      setCreated("");
    } catch (reason) {
      setSelected("");
      setError(message(reason));
    } finally {
      setSaving(false);
    }
  };
  const retry = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError("");
    try {
      await session.agentChoices.refresh(true, { fresh: true });
      if (created) await choose(created, true);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setRefreshing(false);
    }
  };
  const available = choices.selectable;
  const pending = choices.pending || choices.archives.status === "loading";
  const shownError = error || choices.error;
  return (
    <>
      <EmptyState
        icon={<BestieIcon />}
        title={title}
        description={description}
        action={
          <div className="flex w-full max-w-sm flex-col items-center gap-3">
            {(available.length > 0 || pending) && (
              <Select
                label="Your agents"
                variant="field"
                value={selected}
                placeholder={
                  pending && !available.length
                    ? "Loading agents…"
                    : "Choose your Bestie"
                }
                disabled={saving || refreshing || !available.length}
                groups={[
                  {
                    label: "Your agents",
                    options: available.map((agent) => ({
                      value: agent.pubkey,
                      label: agent.managedName ?? agent.name,
                    })),
                  },
                ]}
                onValueChange={(pubkey) => void choose(pubkey)}
              />
            )}
            {!available.length && !pending && !shownError && (
              <p className="m-0 text-body-sm text-muted" role="status">
                You don’t have an eligible agent in this community yet.
              </p>
            )}
            {saving && (
              <p className="m-0 text-body-sm text-muted" role="status">
                Saving your Bestie…
              </p>
            )}
            {shownError && (
              <p className="m-0 text-body-sm text-danger" role="alert">
                {shownError}
              </p>
            )}
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant={available.length ? "outline" : "prominent"}
                size={available.length ? "sm" : "md"}
                disabled={saving || refreshing}
                onClick={() => setCreating(true)}
              >
                Create agent
              </Button>
              {(choices.error || created) && (
                <Button
                  variant="outline"
                  size="sm"
                  loading={refreshing}
                  disabled={saving || refreshing}
                  onClick={() => void retry()}
                >
                  Try again
                </Button>
              )}
            </div>
          </div>
        }
      />
      {creating && (
        <AgentCreateDialog
          agents={agents}
          types={types}
          community={community}
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            setCreated(agent.pubkey);
            setRefreshing(true);
            setError("");
            void session.agentChoices
              .refresh(true, { fresh: true })
              .then(() => choose(agent.pubkey, true))
              .catch((reason) => setError(message(reason)))
              .finally(() => setRefreshing(false));
          }}
        />
      )}
    </>
  );
}
