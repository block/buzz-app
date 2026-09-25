import { useEffect, useRef } from "react";
import {
  canStopAgent,
  agentLaunchBlock,
  type AgentControl,
  type AgentControlState,
  type AgentView,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";
import { agentProcessLabel } from "./agent-edit";

export function ManagedAgentActions({
  agent,
  state,
  control,
  imported,
  onViewProfile,
}: {
  agent: AgentView;
  state: AgentControlState;
  control: AgentControl;
  imported: boolean;
  onViewProfile?: ((trigger: HTMLButtonElement) => void) | undefined;
}) {
  const details = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (imported) {
      details.current?.scrollIntoView?.({ block: "nearest" });
      details.current?.focus();
    }
  }, [imported]);
  const startBlock = agentLaunchBlock(state, agent);
  const act = (action: "start" | "stop") => {
    void control.action(agent.id, action).catch(() => {});
  };
  return (
    <div ref={details} tabIndex={-1} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="m-0 break-all text-body-sm text-secondary">
          {agent.relayUrl}
        </p>
        <p className="m-0 text-body-sm">
          {state.status === "error" && "Last known: "}
          {agentProcessLabel(agent)}
        </p>
      </div>
      {imported && !agent.enabled && (
        <p role="status">
          Imported, not started. Mention this agent in a channel to start it.
        </p>
      )}
      {agent.enabled && (
        <p className="text-body-sm text-secondary">Starts with this app.</p>
      )}
      {agent.error && (
        <p role="alert" className="break-words text-body-sm">
          {agent.error}
        </p>
      )}
      {agent.profilePending && (
        <div className="space-y-2">
          <p role="status">
            Agent saved. Publish its profile so people can find it by name.
          </p>
          <Button
            disabled={
              state.busy || state.status !== "ready" || !control.publishProfile
            }
            onClick={() =>
              void control.publishProfile?.(agent.id).catch(() => {})
            }
          >
            Retry profile
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {onViewProfile && (
          <Button
            variant="primary"
            size="compact"
            onClick={(event) => onViewProfile(event.currentTarget)}
          >
            View profile
          </Button>
        )}
        {agent.status !== "running" && (
          <Button
            variant="primary"
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
      </div>
      {startBlock && agent.status !== "running" && (
        <p className="text-body-sm text-secondary">{startBlock}</p>
      )}
    </div>
  );
}
