import { useEffect, useSyncExternalStore } from "react";
import { relayOrigin } from "../../features/communities/destination";
import type { AgentControl } from "../../features/agents/control";
import type { Navigation } from "../../features/navigation/controller";
import { Button } from "../../shared/design-system/ui/Button";

/** Native-managed identities only. The old library's definition links are not authority. */
export function ProfileInstances({
  control,
  navigation,
  pubkey,
  scope,
  viewer,
}: {
  control: AgentControl;
  navigation: Navigation | undefined;
  pubkey: string;
  scope: string | undefined;
  viewer: string | undefined;
}) {
  const state = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  let origin: string | undefined;
  if (scope && viewer && scope.endsWith(`:${viewer}`)) {
    try {
      origin = relayOrigin(scope.slice(0, -(viewer.length + 1)));
    } catch {
      // An invalid fixture scope must not identify an agent's community.
    }
  }
  useEffect(() => {
    if (origin && state.status === "idle") void control.refresh();
  }, [control, origin, state.status]);
  if (!origin || state.status === "unavailable") return null;
  const instances =
    state.status === "ready"
      ? (state.data?.agents ?? []).filter((agent) => {
          try {
            return (
              agent.pubkey === pubkey && relayOrigin(agent.relayUrl) === origin
            );
          } catch {
            return false;
          }
        })
      : [];
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
      {!!instances.length && navigation && origin && viewer && (
        <Button
          size="compact"
          variant="ghost"
          onClick={() =>
            void navigation.open({
              version: 1,
              kind: "page",
              pluginId: "buzz.agents",
              pageId: "agents",
              scope: { viewer, communityOrigin: origin },
            })
          }
        >
          View in Agents
        </Button>
      )}
    </section>
  );
}
