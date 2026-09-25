import { useEffect, useSyncExternalStore } from "react";
import { sameCommunityAgents } from "../../features/agents/choices";
import type { AgentControl } from "../../features/agents/control";
import type { Navigation } from "../../features/navigation/controller";
import type { PanelProps } from "../../features/panels/service";
import type { RelaySession } from "../../features/relay/session";
import { instanceTarget } from "../../features/profiles/instance-target";
import { Button } from "../../shared/design-system/ui/Button";

/** Native-managed identities only. The old library's definition links are not authority. */
export function ProfileInstances({
  control,
  context,
  navigation,
  session,
  canOpenPrivate = false,
  selectedId,
  pubkey,
  scope,
  communityOrigin,
  viewer,
  knownAgent,
  owned = false,
  errorHandledByActions = false,
}: {
  control: AgentControl;
  context?: PanelProps["context"];
  navigation?: Navigation | undefined;
  session: RelaySession;
  canOpenPrivate?: boolean;
  selectedId?: string | undefined;
  pubkey: string;
  scope: string | undefined;
  communityOrigin: string | undefined;
  viewer: string | undefined;
  knownAgent: boolean;
  owned?: boolean;
  /** The composed Info actions surface owns controller failure and recovery. */
  errorHandledByActions?: boolean;
}) {
  const state = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  const archives = useSyncExternalStore(
    session.archives.subscribe,
    session.archives.snapshot,
    session.archives.snapshot,
  );
  const matches = scope
    ? sameCommunityAgents(state.data?.agents ?? [], scope).filter(
        (agent) => agent.pubkey === pubkey,
      )
    : [];
  const hasInstances = !!communityOrigin && matches.length > 0;
  useEffect(() => {
    if (hasInstances && archives.status === "idle")
      void session.archives.ensure();
  }, [session, hasInstances, archives.status]);
  useEffect(() => {
    if (communityOrigin && knownAgent && state.status === "idle")
      void control.refresh();
  }, [control, communityOrigin, knownAgent, state.status]);
  if (!communityOrigin || state.status === "unavailable") return null;
  // Actions own errors only with unknown inventory or one exact native match.
  if (
    state.status === "error" &&
    errorHandledByActions &&
    (!state.data || matches.length === 1 || !!selectedId)
  )
    return null;
  const instances = state.status === "ready" ? matches : [];
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
          <p role="alert">
            {errorHandledByActions
              ? "Managed agent status is unconfirmed."
              : "Could not refresh managed agents."}
          </p>
          <Button size="compact" onClick={() => void control.refresh()}>
            Retry agents
          </Button>
        </div>
      ) : !instances.length ? (
        <p>No managed instance for this identity in this community.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {instances.map((agent) => {
            const target =
              viewer && communityOrigin
                ? instanceTarget({
                    id: agent.id,
                    pubkey,
                    viewer,
                    communityOrigin,
                  })
                : undefined;
            const archived =
              archives.status === "ready" &&
              archives.archived.includes(agent.pubkey);
            return (
              <li key={agent.id}>
                {target && canOpenPrivate && context?.canOpen(target) ? (
                  <Button
                    size="compact"
                    variant="ghost"
                    aria-current={selectedId === agent.id ? "true" : undefined}
                    onClick={() => context.open(target)}
                  >
                    {agent.name}
                  </Button>
                ) : (
                  agent.name
                )}
                {archived
                  ? " Archived"
                  : selectedId === agent.id
                    ? " Current"
                    : ""}
              </li>
            );
          })}
        </ul>
      )}
      {owned && instances.length === 1 && navigation && viewer && (
        <Button
          size="compact"
          variant="ghost"
          onClick={() => {
            // Recheck the native snapshot before opening an owner-scoped editor.
            const current = control.snapshot();
            const currentMatches =
              scope && current.status === "ready"
                ? sameCommunityAgents(current.data?.agents ?? [], scope).filter(
                    (agent) => agent.pubkey === pubkey,
                  )
                : [];
            if (currentMatches.length !== 1) return;
            void navigation.open({
              version: 1,
              kind: "page",
              pluginId: "buzz.agents",
              pageId: "agents",
              scope: { viewer, communityOrigin },
              route: { version: 1, params: { pubkey } },
            });
          }}
        >
          Agent instructions
        </Button>
      )}
    </section>
  );
}
