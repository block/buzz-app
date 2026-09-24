import { useEffect, useRef, useState } from "react";
import {
  canStopAgent,
  agentLaunchBlock,
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
  showCommunity = true,
  onUseHere,
}: {
  agent: AgentView;
  state: AgentControlState;
  control: AgentControl;
  imported: boolean;
  destination?: string;
  owner?: string;
  showCommunity?: boolean;
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
  const startBlock = agentLaunchBlock(state, agent);
  const act = (action: "start" | "stop") => {
    void control.action(agent.id, action).catch(() => {});
  };
  return (
    <div ref={details} tabIndex={-1} className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        {showCommunity && (
          <p className="m-0 break-all text-body-sm text-secondary">
            {agent.relayUrl}
          </p>
        )}
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
        (onUseHere &&
        state.data?.localInventoryActions &&
        control.configureHere ? (
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
      {agent.enabled && (
        <p className="m-0 text-body-sm text-secondary">Starts with this app.</p>
      )}
      {agent.error && (
        <p role="alert" className="m-0 break-words text-body-sm">
          {agent.error}
        </p>
      )}
      {agent.profilePending && (
        <div className="space-y-2">
          <p role="status" className="m-0 text-body-sm">
            Settings saved. Profile publication is pending.
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
        {agent.status !== "running" && (
          <Button
            variant="primary"
            size="compact"
            disabled={!!startBlock || settingUp}
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
        <p className="m-0 text-body-sm text-secondary">{startBlock}</p>
      )}
    </div>
  );
}
