import { useEffect, useSyncExternalStore } from "react";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import type { Navigation } from "../../features/navigation/controller";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { useRelayConnection } from "../../features/relay/react";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { AgentLibrary } from "./AgentLibrary";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentCard } from "./AgentCard";
import { AgentControlPanel } from "./AgentControlPanel";
import { ManagedAgentActions } from "./ManagedAgentActions";

export function AgentsPage({
  relay,
  control,
  navigator,
}: {
  relay: RelayData;
  control?: AgentControl;
  navigator?: Navigation;
}) {
  const connection = useRelayConnection(relay);
  const library =
    connection.status === "ready" ? (
      <AgentLibrary
        key={`${connection.scope}:${connection.generation}`}
        session={connection.session}
      />
    ) : (
      <div>
        <p>Connect to a community to browse the old library.</p>
        {connection.status === "error" && (
          <Button onClick={() => relay.retry()}>Retry connection</Button>
        )}
      </div>
    );
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Agents">
        <div className="h-full min-h-0 overflow-auto p-panel-inset text-body">
          <div className="mx-auto max-w-6xl space-y-5">
            <h1 className="m-0 text-title text-primary">Agents</h1>
            {control ? (
              <AgentControlPanel control={control}>
                {(state, edit, importedId) =>
                  state.status === "unavailable" ? (
                    library
                  ) : (
                    <ManagedAgents
                      key={`${connection.scope}:${connection.generation}`}
                      state={state}
                      edit={edit}
                      importedId={importedId}
                      control={control}
                      connection={connection}
                      relay={relay}
                      navigator={navigator}
                    />
                  )
                }
              </AgentControlPanel>
            ) : (
              <>
                <p className="text-secondary">
                  Open the desktop app to import and run agents. You can still
                  mention existing channel members.
                </p>
                {library}
              </>
            )}
          </div>
        </div>
      </FullPageSurface>
    </div>
  );
}
function ManagedAgents({
  state,
  edit,
  importedId,
  control,
  connection,
  relay,
  navigator,
}: {
  state: AgentControlState;
  edit(agent: AgentView, avatar?: string): void;
  importedId: string | null;
  control: AgentControl;
  connection: RelaySnapshot;
  relay: RelayData;
  navigator?: Navigation | undefined;
}) {
  const library = connection.session.agentLibrary;
  const snapshot = useSyncExternalStore(
    library.subscribe,
    library.snapshot,
    library.snapshot,
  );
  useEffect(() => {
    if (connection.status === "ready") void library.refresh();
  }, [library, connection.status]);
  return (
    <section aria-label="My agents" className="space-y-3">
      <h2 className="m-0 text-heading">
        My agents{" "}
        <span className="text-secondary">{state.data?.agents.length ?? 0}</span>
      </h2>
      <p className="text-secondary">
        Start an agent, then mention it in a channel or thread. Stop old Buzz
        and its listeners before starting an imported identity here.
      </p>
      {state.data?.agents.length === 0 && (
        <p>No agents yet. Choose Add agent to import one.</p>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
        {state.data?.agents.map((agent) => {
          const identity = snapshot.identities.find(
            (entry) => entry.pubkey === agent.pubkey,
          );
          const avatar =
            identity?.avatar ??
            snapshot.definitions.find(
              (entry) => entry.id === identity?.definitionId,
            )?.avatar;
          return (
            <AgentCard
              key={agent.id}
              name={agent.name}
              avatar={avatar}
              identities={[agent]}
              session={connection.session}
              editable={[agent]}
              onEdit={edit}
            >
              <ManagedAgentActions
                agent={agent}
                state={state}
                control={control}
                imported={agent.id === importedId}
                connection={connection}
                relay={relay}
                navigator={navigator}
              />
            </AgentCard>
          );
        })}
      </div>
    </section>
  );
}
