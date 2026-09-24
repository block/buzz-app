import { useEffect, useRef, useState } from "react";
import {
  canStopAgent,
  type AgentControl,
  type AgentControlState,
  type AgentView,
} from "../../features/agents/control";
import { LocalInventoryAction } from "./LocalInventoryAction";
import { Button } from "../../shared/design-system/ui/Button";
import { agentProcessLabel } from "./agent-edit";

export function ManagedAgentActions({
  agent,
  state,
  control,
  imported,
  destination = "",
  owner = "",
  onUseHere,
}: {
  agent: AgentView;
  state: AgentControlState;
  control: AgentControl;
  imported: boolean;
  destination?: string;
  owner?: string;
  onUseHere?: ((pubkey: string, action: "use" | "clone") => void) | undefined;
}) {
  const [settingUp, setSettingUp] = useState(false);
  const details = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (imported) {
      details.current?.scrollIntoView?.({ block: "nearest" });
      details.current?.focus();
    }
  }, [imported]);
  const transitioning =
    agent.status === "starting" || agent.status === "stopping";
  const startBlock =
    state.status !== "ready"
      ? "Refresh status before starting."
      : state.pendingLaunch === agent.id
        ? "Starting this agent."
        : state.queuedLaunches?.includes(agent.id)
          ? "Queued to start after the current agent."
          : state.busy && (!state.pendingLaunch || state.stopping)
            ? "Waiting for the current operation."
            : !state.data?.runtimeAvailable
              ? state.data?.runtimeMessage ||
                "The bundled agent runtime is unavailable."
              : transitioning
                ? "Waiting for the process transition."
                : null;
  const act = (action: "start" | "stop") => {
    void control.action(agent.id, action).catch(() => {});
  };
  return (
    <div ref={details} tabIndex={-1} className="flex flex-col gap-2">
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
        <p role="status" className="m-0 text-body-sm">
          Imported, not started.{" "}
          {agent.configured === false
            ? "Choose Use here to set up this identity in a community."
            : "Start it when you are ready."}
        </p>
      )}
      {agent.configured === false &&
        (onUseHere ? (
          <Button
            disabled={state.busy || state.status !== "ready"}
            onClick={() => onUseHere(agent.pubkey, "use")}
          >
            Use here
          </Button>
        ) : state.data?.localInventoryActions && control.configureHere ? (
          <LocalInventoryAction
            control={control}
            agent={agent}
            action="use"
            destination={destination}
            owner={owner}
            disabled={state.busy || state.status !== "ready"}
            onPending={setSettingUp}
            onUsed={() => {}}
            onClone={() => {}}
          />
        ) : (
          <p>Update the desktop app to set up this imported identity.</p>
        ))}
      {agent.startOnAppLaunch && (
        <p className="m-0 text-body-sm text-secondary">Starts with this app.</p>
      )}
      {agent.error && (
        <p role="alert" className="m-0 break-words text-body-sm">
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
        {(agent.status === "stopped" || agent.status === "failed") && (
          <Button
            variant="primary"
            size="compact"
            disabled={!!startBlock || settingUp}
            onClick={() => act("start")}
          >
            {agent.status === "failed" ? "Retry start" : "Start"}
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
        <p className="m-0 text-body-sm text-secondary">{startBlock}</p>
      )}
    </div>
  );
}
