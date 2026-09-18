import type {
  AgentControl,
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import { AgentCard } from "./AgentCard";
import { AgentControlPanel } from "./AgentControlPanel";
import { IconRefresh } from "@tabler/icons-react";
import { Button } from "../../shared/design-system/ui/Button";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import {
  groupAgentLibrary,
  type AgentLibrary,
} from "../../features/agents/library";
import { useEffect, useSyncExternalStore } from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useRelayConnection } from "../../features/relay/react";

export function AgentsPage({
  relay,
  control,
}: {
  relay: RelayData;
  control?: AgentControl;
}) {
  const connection = useRelayConnection(relay);
  const disconnected = (
    <div className="mt-6 space-y-3 text-body">
      <p>
        {connection.status === "connecting"
          ? "Connecting to your community…"
          : "Connect to a community to browse your agents."}
      </p>
      {connection.status === "error" && (
        <Button onClick={() => relay.retry()}>Retry connection</Button>
      )}
    </div>
  );
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Agents">
        <div className="h-full min-h-0 overflow-auto p-panel-inset text-body">
          <h1 className="m-0 text-title text-primary">Agents</h1>
          {control ? (
            <AgentControlPanel control={control}>
              {(state, edit) =>
                connection.status === "ready" ? (
                  <MyAgents
                    key={`${connection.scope}:${connection.generation}`}
                    session={connection.session}
                    state={state}
                    onEdit={edit}
                  />
                ) : (
                  <>
                    {disconnected}
                    <LocalAgents state={state} onEdit={edit} />
                  </>
                )
              }
            </AgentControlPanel>
          ) : connection.status === "ready" ? (
            <MyAgents
              key={`${connection.scope}:${connection.generation}`}
              session={connection.session}
            />
          ) : (
            disconnected
          )}
        </div>
      </FullPageSurface>
    </div>
  );
}
function LocalAgents({
  state,
  onEdit,
}: {
  state: AgentControlState;
  onEdit(agent: AgentView, avatar?: string): void;
}) {
  return (
    <div className="agent-grid">
      {state.data?.agents.map((agent) => (
        <AgentCard
          key={agent.id}
          name={agent.name}
          identities={[agent]}
          editable={[agent]}
          onEdit={onEdit}
        />
      ))}
    </div>
  );
}
function MyAgents({
  session,
  state,
  onEdit,
}: {
  session: RelaySession;
  state?: AgentControlState;
  onEdit?(agent: AgentView, avatar?: string): void;
}) {
  const library = session.agentLibrary;
  const archives = session.archives;
  const snapshot = useSyncExternalStore(
    library.subscribe,
    library.snapshot,
    library.snapshot,
  );
  const archive = useSyncExternalStore(
    archives.subscribe,
    archives.snapshot,
    archives.snapshot,
  );
  const refresh = () => {
    void library.refresh();
    void archives.refresh();
  };
  useEffect(() => {
    void library.refresh();
    void archives.refresh();
  }, [library, archives]);
  const { groups, custom, unknown } = groupAgentLibrary(
    snapshot,
    (key) => archives.state(key) === "archived",
  );
  const loading = snapshot.status === "loading";
  const native = state?.data?.agents ?? [];
  const linked = new Set(
    [...groups.flatMap((group) => group.identities), ...custom, ...unknown].map(
      (identity) => identity.pubkey,
    ),
  );
  const local = native.filter((agent) => !linked.has(agent.pubkey));
  const edits = (identities: AgentLibrary["identities"]) =>
    native.filter((agent) =>
      identities.some((identity) => identity.pubkey === agent.pubkey),
    );
  return (
    <div className="mx-auto mt-2 max-w-6xl space-y-section-gap">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-body text-secondary">Your agents from Buzz.</p>
        <Button
          variant="quiet"
          size="compact"
          disabled={loading || snapshot.status === "unavailable"}
          onClick={refresh}
        >
          <IconRefresh size={16} stroke={2} aria-hidden="true" />
          {snapshot.status === "error" ? "Retry" : "Refresh agents"}
        </Button>
      </div>
      {loading && (
        <p className="text-body" role="status">
          Reading your Buzz library…
        </p>
      )}
      {snapshot.status === "idle" && (
        <p className="text-body" role="status">
          Library cleared. Refresh to read it again.
        </p>
      )}
      {snapshot.status === "unavailable" && (
        <p className="text-body" role="status">
          The current Buzz library is available through the local live
          development host. See README for live setup.
        </p>
      )}
      {snapshot.error && (
        <p className="text-body" role="alert">
          {snapshot.error}
        </p>
      )}
      {snapshot.status !== "ready" && state && onEdit && (
        <LocalAgents state={state} onEdit={onEdit} />
      )}
      {snapshot.status === "ready" && (
        <>
          <section aria-label="My agents" className="space-y-3">
            <h2 className="m-0 flex items-center gap-2 text-heading">
              My agents{" "}
              <span className="rounded-md bg-neutral-2 px-2 py-0.5 text-body-sm font-normal text-secondary">
                {groups.length}
              </span>
            </h2>
            {!groups.length && (
              <p className="py-8 text-center text-body text-secondary">
                No selected agents in your Buzz library.
              </p>
            )}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4">
              {groups.map((group) => (
                <AgentCard
                  key={group.id}
                  name={group.name}
                  avatar={group.avatar ?? group.identities[0]?.avatar}
                  identities={group.identities}
                  session={session}
                  editable={edits(group.identities)}
                  onEdit={onEdit}
                />
              ))}
            </div>
          </section>
          {!!custom.length && (
            <section aria-label="Custom agents" className="space-y-3">
              <h2 className="m-0 text-heading">Custom agents</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4">
                {custom.map((identity) => (
                  <AgentCard
                    key={identity.pubkey}
                    name={identity.name}
                    avatar={identity.avatar}
                    identities={[identity]}
                    session={session}
                    editable={edits([identity])}
                    onEdit={onEdit}
                  />
                ))}
              </div>
            </section>
          )}
          {!!unknown.length && (
            <section aria-label="Unknown agents" className="space-y-3">
              <h2 className="m-0 text-heading">Other identities</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4">
                {unknown.map((identity) => (
                  <AgentCard
                    key={identity.pubkey}
                    name={identity.name}
                    avatar={identity.avatar}
                    identities={[identity]}
                    session={session}
                    editable={edits([identity])}
                    onEdit={onEdit}
                  />
                ))}
              </div>
            </section>
          )}
          {archive.status !== "ready" && (
            <p className="text-body text-secondary">
              Archive visibility is unknown. Library entries remain visible;
              this does not grant channel access.
            </p>
          )}
          {!!local.length && (
            <section aria-label="Local agents" className="space-y-3">
              <h2 className="text-heading">Local agents</h2>
              <div className="agent-grid">
                {local.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    name={agent.name}
                    identities={[agent]}
                    editable={[agent]}
                    onEdit={onEdit}
                  />
                ))}
              </div>
            </section>
          )}
          <p className="border-t border-primary pt-4 text-body-sm text-secondary">
            Mention existing members with @ in a channel or thread. This is your
            current Buzz library, read-only; keep Buzz running for replies.
          </p>
        </>
      )}
    </div>
  );
}
