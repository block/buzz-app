import { useEffect, useSyncExternalStore } from "react";
import { sameCommunityAgents } from "../../features/agents/choices";
import type { AgentControl } from "../../features/agents/control";
import type { Navigation } from "../../features/navigation/controller";
import { Button } from "../../shared/design-system/ui/Button";

/** Native-managed identities only. The old library's definition links are not authority. */
export function ProfileInstances({
  control,
  navigation,
  pubkey,
  scope,
  communityOrigin,
  viewer,
  knownAgent,
}: {
  control: AgentControl;
  navigation: Navigation | undefined;
  pubkey: string;
  scope: string | undefined;
  communityOrigin: string | undefined;
  viewer: string | undefined;
  knownAgent: boolean;
}) {
  const state = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  useEffect(() => {
    if (communityOrigin && knownAgent && state.status === "idle")
      void control.refresh();
  }, [control, communityOrigin, knownAgent, state.status]);
  if (!communityOrigin || state.status === "unavailable") return null;
  const instances =
    scope && state.status === "ready"
      ? sameCommunityAgents(state.data?.agents ?? [], scope).filter(
          (agent) => agent.pubkey === pubkey,
        )
      : [];
  if (!knownAgent && !instances.length) return null;
  return (
    <section
      aria-label="Linked agent instances"
      className="flex flex-col gap-2"
    >
      <h3 className="m-0 text-heading">Linked agent instances</h3>
      {state.status === "loading" || state.status === "idle" ? (
        <p role="status">Loading managed agents…</p>
      ) : state.status === "error" ? (
        <div>
          <p role="alert">Could not refresh managed agents.</p>
          <Button size="compact" onClick={() => void control.refresh()}>
            Retry agents
          </Button>
        </div>
      ) : !instances.length ? (
        <p>No managed instance for this identity in this community.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {instances.map((agent) => (
            <li key={agent.id}>
              {agent.name} · {agent.status}
            </li>
          ))}
        </ul>
      )}
      {!!instances.length && navigation && viewer && (
        <Button
          size="compact"
          variant="ghost"
          onClick={() =>
            void navigation.open({
              version: 1,
              kind: "page",
              pluginId: "buzz.agents",
              pageId: "agents",
              scope: { viewer, communityOrigin },
            })
          }
        >
          View in Agents
        </Button>
      )}
    </section>
  );
}
