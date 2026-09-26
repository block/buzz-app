import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  canStopAgent,
  agentLaunchBlock,
  type AgentControl,
  type AgentControlState,
  type AgentView,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";
import { agentProcessLabel } from "./agent-edit";
import type { AgentProviders } from "../../features/agents/providers";

export function ManagedAgentActions({
  agent,
  state,
  control,
  imported,
  providers,
}: {
  providers?: AgentProviders | undefined;
  agent: AgentView;
  state: AgentControlState;
  control: AgentControl;
  imported: boolean;
}) {
  const details = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (imported) {
      details.current?.scrollIntoView?.({ block: "nearest" });
      details.current?.focus();
    }
  }, [imported]);
  if (agent.provider)
    return (
      <ProviderAgentStatus
        agent={agent}
        providers={providers}
        state={state}
        control={control}
      />
    );
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
          <p role="status">Settings saved. Profile publication is pending.</p>
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

const none: ReturnType<AgentProviders["snapshot"]> = [];
const noProviders = () => none;
const noSubscription = () => () => {};

/** No process to start or stop: the provider plugin runs on each admitted mention. */
function ProviderAgentStatus({
  agent,
  providers,
  state,
  control,
}: {
  agent: AgentView;
  providers?: AgentProviders | undefined;
  state: AgentControlState;
  control: AgentControl;
}) {
  const active = useSyncExternalStore(
    providers?.subscribe ?? noSubscription,
    providers?.snapshot ?? noProviders,
    providers?.snapshot ?? noProviders,
  );
  const provider = active.find((entry) => entry.key === agent.provider);
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 break-all text-body-sm text-secondary">
        {agent.relayUrl}
      </p>
      <p className="m-0 text-body-sm">
        {provider
          ? `Runs with ${provider.title} when mentioned.`
          : `Its provider (${agent.provider}) is not enabled. Mentions wait until it is.`}
      </p>
      {agent.profilePending && (
        <Button
          size="compact"
          disabled={
            state.busy || state.status !== "ready" || !control.publishProfile
          }
          onClick={() =>
            void control.publishProfile?.(agent.id).catch(() => {})
          }
        >
          Retry profile
        </Button>
      )}
    </div>
  );
}
