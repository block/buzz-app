import { useEffect, useRef, useState } from "react";
import {
  canStopAgent,
  type AgentControl,
  type AgentControlState,
  type AgentView,
} from "../../features/agents/control";
import type { Navigation } from "../../features/navigation/controller";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { relayOrigin } from "../../features/communities/destination";
import { Button } from "../../shared/design-system/ui/Button";
import { agentProcessLabel } from "./agent-edit";
import { AgentChannelPicker } from "./AgentChannelPicker";

export function ManagedAgentActions({
  agent,
  state,
  control,
  imported,
  connection,
  relay,
  navigator,
}: {
  agent: AgentView;
  state: AgentControlState;
  control: AgentControl;
  imported: boolean;
  connection: RelaySnapshot;
  relay: RelayData;
  navigator?: Navigation | undefined;
}) {
  const [choosing, setChoosing] = useState(false);
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
      : state.busy
        ? "Waiting for the current operation."
        : !state.data?.runtimeAvailable
          ? state.data?.runtimeMessage ||
            "The bundled agent runtime is unavailable."
          : transitioning
            ? "Waiting for the process transition."
            : null;
  const matchesCommunity =
    !!connection.viewer &&
    !!connection.scope &&
    connection.scope === `${relayOrigin(agent.relayUrl)}:${connection.viewer}`;
  const useBlock =
    connection.status !== "ready"
      ? "Connect to this agent’s community to choose a channel."
      : !matchesCommunity
        ? "Switch to this agent’s community to choose a channel."
        : !navigator
          ? "Channel navigation is unavailable."
          : null;
  const act = (action: "start" | "stop") => {
    void control.action(agent.id, action).catch(() => {});
  };
  return (
    <div ref={details} tabIndex={-1} className="my-3 space-y-3">
      <p className="m-0 break-all text-body-sm text-secondary">
        {agent.relayUrl}
      </p>
      <p className="m-0 text-body-sm">
        {state.status === "error" && "Last known: "}
        {agentProcessLabel(agent)}
      </p>
      {imported && !agent.enabled && (
        <p role="status">Imported, not started. Review settings, then Start.</p>
      )}
      {agent.enabled && (
        <p className="text-body-sm text-secondary">Starts with this app.</p>
      )}
      {agent.error && (
        <p role="alert" className="break-words text-body-sm">
          {agent.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {agent.status !== "running" && (
          <Button
            variant="primary"
            disabled={!!startBlock}
            onClick={() => act("start")}
          >
            Start
          </Button>
        )}
        <Button
          disabled={!canStopAgent(state, agent.id)}
          onClick={() => act("stop")}
        >
          Stop
        </Button>
      </div>
      {startBlock && agent.status !== "running" && (
        <p className="text-body-sm text-secondary">{startBlock}</p>
      )}
      <Button
        disabled={!!useBlock}
        onClick={() => setChoosing(!choosing)}
        aria-expanded={choosing}
      >
        Use in channel
      </Button>
      {useBlock && <p className="text-body-sm text-secondary">{useBlock}</p>}
      {choosing && !useBlock && navigator && (
        <AgentChannelPicker
          key={`${connection.scope}:${connection.generation}`}
          agent={agent}
          connection={connection}
          relay={relay}
          navigator={navigator}
        />
      )}
    </div>
  );
}
