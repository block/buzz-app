import { useCallback, useLayoutEffect, useRef } from "react";
import { useAgentControl } from "../../features/agents/control-react";
import {
  canStopAgent,
  agentLaunchBlock,
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
  const state = useAgentControl(control);
  const stopButton = useRef<HTMLButtonElement>(null);
  const restoreStartFocus = useRef(false);
  const startRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    // Capture focus before React removes Start, not after it falls back to body.
    return () => {
      restoreStartFocus.current = document.activeElement === node;
    };
  }, []);
  useLayoutEffect(() => {
    if (restoreStartFocus.current && document.activeElement === document.body)
      stopButton.current?.focus();
    restoreStartFocus.current = false;
  });
  if (connection.status !== "ready" || !connection.scope) return null;
  const matches = sameCommunityAgents(
    state.data?.agents ?? [],
    connection.scope,
  ).filter((agent) => agent.pubkey === pubkey);
  // A native ID is actionable only when the identity/destination is unambiguous.
  const agent = matches.length === 1 ? matches[0] : undefined;
  if (!agent && (state.status !== "error" || state.data)) return null;
  const startBlock = agent ? agentLaunchBlock(state, agent) : null;
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
                ref={startRef}
                focusableWhenDisabled
                disabled={!!startBlock}
                onClick={() => act("start")}
              >
                Start
              </Button>
            )}
            <Button
              ref={stopButton}
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
