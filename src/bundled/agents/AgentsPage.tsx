import { useIdentityNames } from "../../features/identity-names/react";
import { useEffect, useSyncExternalStore } from "react";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { relayOrigin } from "../../features/communities/destination";
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
}: {
  relay: RelayData;
  control?: AgentControl;
}) {
  const connection = useRelayConnection(relay);
  const resolveName = useIdentityNames(connection.session.names);
  let importDestination = "";
  if (
    connection.viewer &&
    connection.scope?.endsWith(`:${connection.viewer}`)
  ) {
    try {
      importDestination = relayOrigin(
        connection.scope.slice(0, -(connection.viewer.length + 1)),
      );
    } catch {
      // A non-URL fixture or unavailable connection needs an explicit destination.
    }
  }
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
          <div className="mx-auto flex max-w-6xl flex-col gap-panel-gap">
            {!control && (
              <h1 className="m-0 text-title text-primary">Agents</h1>
            )}
            {control ? (
              <AgentControlPanel
                control={control}
                resolveName={resolveName}
                importDestination={importDestination}
                createOwner={
                  connection.status === "ready" ? connection.viewer : undefined
                }
              >
                {(state, edit, importedId, label, onUseHere) =>
                  state.status === "unavailable" ? (
                    library
                  ) : (
                    <ManagedAgents
                      key={`${connection.scope}:${connection.generation}`}
                      onUseHere={onUseHere}
                      state={state}
                      label={label}
                      edit={edit}
                      importedId={importedId}
                      control={control}
                      connection={connection}
                      destination={importDestination}
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
  label,
  destination,
  onUseHere,
}: {
  label(agent: AgentView): string;
  state: AgentControlState;
  edit(agent: AgentView, avatar?: string): void;
  importedId: string | null;
  control: AgentControl;
  connection: RelaySnapshot;
  destination: string;
  onUseHere(pubkey: string, action: "use" | "clone"): void;
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
    <section aria-label="My agents" className="flex flex-col gap-4">
      <h2 className="sr-only">My agents</h2>
      <p className="m-0 text-body-sm text-secondary">
        Mention an agent in a channel to add it and start it. Stop old Buzz and
        its listeners before using an imported identity here.
      </p>
      {state.data?.agents.length === 0 && (
        <p>No agents yet. Create an agent or import one from old Buzz below.</p>
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
              name={label(agent)}
              avatar={avatar}
              identities={[agent]}
              session={connection.session}
              editable={[agent]}
              onEdit={edit}
            >
              <ManagedAgentActions
                agent={agent}
                onUseHere={onUseHere}
                state={state}
                control={control}
                imported={agent.id === importedId}
                destination={destination}
                owner={
                  connection.status === "ready" ? (connection.viewer ?? "") : ""
                }
              />
            </AgentCard>
          );
        })}
      </div>
    </section>
  );
}
