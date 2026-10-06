import { useEffect, useRef, useState } from "react";
import {
  agentFailureReason,
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
  action,
  destination = "",
  owner = "",
  showCommunity = true,
  onUseHere,
}: {
  agent: AgentView;
  state: AgentControlState;
  control: AgentControl;
  imported: boolean;
  action: ManagedAction;
  destination?: string;
  owner?: string;
  showCommunity?: boolean;
  onUseHere?: ((pubkey: string, action: "use" | "clone") => void) | undefined;
}) {
  const [settingUp, setSettingUp] = useState(false);
  const details = useRef<HTMLDivElement>(null);
  const { checking, notice, act } = action;
  useEffect(() => {
    if (imported) {
      details.current?.scrollIntoView?.({ block: "nearest" });
      details.current?.focus();
    }
  }, [imported]);
  const startBlock = agentLaunchBlock(state, agent);
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
        (onUseHere ? (
          <Button
            disabled={state.busy || state.status !== "ready"}
            onClick={() => onUseHere(agent.pubkey, "use")}
          >
            Use here
          </Button>
        ) : control.configureHere ? (
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
        ) : null)}
      {agent.startOnAppLaunch && (
        <p className="m-0 text-body-sm text-secondary">Starts with this app.</p>
      )}
      {agent.error && (
        <p role="alert" className="m-0 break-words text-body-sm">
          {agent.error}
        </p>
      )}
      {checking && <p role="status">Checking agent status…</p>}
      {!checking && notice && !agent.error && <p role="alert">{notice}</p>}
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

export type ManagedAction = {
  checking: boolean;
  notice: string | null;
  act(action: "start" | "stop"): void;
};

/** Owned by the card/list, not the disposable Manage dialog body. */
export function useManagedAgentActions(
  state: AgentControlState,
  control: AgentControl,
) {
  const [outcomes, setOutcomes] = useState<
    Record<
      string,
      {
        status: AgentView["status"];
        checking: boolean;
        notice: string | null;
      }
    >
  >({});
  const attempts = useRef(new Map<string, object>());
  const [observed, setObserved] = useState(state.data?.agents);
  if (observed !== state.data?.agents) {
    setObserved(state.data?.agents);
    setOutcomes((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id, outcome]) =>
          state.data?.agents.some(
            (agent) => agent.id === id && agent.status === outcome.status,
          ),
        ),
      ),
    );
  }
  return (agent: AgentView): ManagedAction => ({
    checking: outcomes[agent.id]?.checking ?? false,
    notice: outcomes[agent.id]?.notice ?? null,
    act(action) {
      const attempt = {};
      attempts.current.set(agent.id, attempt);
      const currentAttempt = () => attempts.current.get(agent.id) === attempt;
      setOutcomes((current) => ({
        ...current,
        [agent.id]: {
          status: agent.status,
          checking: false,
          notice: null,
        },
      }));
      void control.action(agent.id, action).catch(async (problem: unknown) => {
        if (!currentAttempt()) return;
        setOutcomes((current) => ({
          ...current,
          [agent.id]: {
            status: agent.status,
            checking: true,
            notice: null,
          },
        }));
        await control.refresh();
        if (!currentAttempt()) return;
        const refreshed = control.snapshot();
        const current = refreshed.data?.agents.find(
          (item) => item.id === agent.id,
        );
        const succeeded =
          current &&
          (action === "start"
            ? current.status === "running"
            : current.status === "stopped" && !current.enabled);
        const reason = agentFailureReason(problem);
        setOutcomes((outcomes) => {
          const next = { ...outcomes };
          delete next[agent.id];
          if (current && !current.error && !succeeded)
            next[agent.id] = {
              status: current.status,
              checking: false,
              notice:
                refreshed.status === "ready"
                  ? `The agent didn't ${action}.${reason && ` ${reason}`} Try again.`
                  : `We couldn't confirm whether the agent ${action === "start" ? "started" : "stopped"}. Refresh status before trying again.`,
            };
          return next;
        });
      });
    },
  });
}
