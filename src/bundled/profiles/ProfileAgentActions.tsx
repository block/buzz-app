import { useEffect, useSyncExternalStore } from "react";
import {
  canStopAgent,
  type AgentAction,
  type AgentControl,
} from "../../features/agents/control";
import { sameCommunityAgents } from "../../features/agents/choices";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { Button } from "../../shared/design-system/ui/Button";

/** Observe the app-owned controller; profile metadata never grants control. */
export function ProfileAgentActions({
  control,
  relay,
  pubkey,
}: {
  control: AgentControl;
  relay: RelayData;
  pubkey: string;
}) {
  const connection = useRelayConnection(relay);
  const state = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  useEffect(() => {
    void control.refresh();
    const timer = setInterval(() => {
      if (
        document.visibilityState !== "hidden" &&
        control.snapshot().status === "ready"
      )
        void control.refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [control]);
  if (connection.status !== "ready" || !connection.scope) return null;
  const matches = sameCommunityAgents(
    state.data?.agents ?? [],
    connection.scope,
  ).filter((agent) => agent.pubkey === pubkey);
  // A native ID is actionable only when the identity/destination is unambiguous.
  const agent = matches.length === 1 ? matches[0] : undefined;
  if (!agent && state.status !== "error") return null;
  const transitioning =
    agent?.status === "starting" || agent?.status === "stopping";
  const startBlock =
    state.status !== "ready"
      ? "Refresh status before starting."
      : state.busy
        ? "Waiting for the current operation."
        : !state.data?.runtimeAvailable
          ? state.data?.runtimeMessage ||
            "The bundled agent runtime is unavailable."
          : transitioning
            ? "Waiting for the process transition."
            : null;
  const act = (action: AgentAction) => {
    // A retired presentation cannot dispatch into a newly selected community.
    if (!agent || relay.snapshot() !== connection) return;
    const current = control.snapshot();
    if (action === "stop" ? !canStopAgent(current, agent.id) : !!startBlock)
      return;
    void control.action(agent.id, action).catch(() => {});
  };
  return (
    <section aria-label="Local agent actions" className="flex flex-col gap-2">
      {agent && (
        <>
          <div className="flex flex-wrap gap-2">
            {agent.status !== "running" && (
              <Button
                size="compact"
                disabled={!!startBlock}
                onClick={() => act("start")}
              >
                Start
              </Button>
            )}
            <Button
              size="compact"
              disabled={!canStopAgent(state, agent.id)}
              onClick={() => act("stop")}
            >
              Stop
            </Button>
            <Button
              size="compact"
              disabled={!!startBlock}
              onClick={() => act("restart")}
            >
              Restart
            </Button>
          </div>
          {startBlock && (
            <p className="text-body-sm text-secondary">{startBlock}</p>
          )}
          {agent.error && <p role="alert">{agent.error}</p>}
        </>
      )}
      {state.error && <p role="alert">{state.error}</p>}
      {state.status === "error" && (
        <>
          {agent && (
            <p className="text-body-sm text-secondary">
              Showing the last host snapshot. Current process state and durable
              enabled intent are unconfirmed.
            </p>
          )}
          <Button
            size="compact"
            disabled={state.busy}
            onClick={() => void control.refresh()}
          >
            Retry status
          </Button>
        </>
      )}
      {state.busy && <p role="status">Waiting for the host to confirm…</p>}
    </section>
  );
}
