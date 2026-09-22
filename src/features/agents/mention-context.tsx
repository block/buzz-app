import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { AgentControl, AgentView } from "./control";
import { relayOrigin } from "../communities/destination";

export const AgentMentionContext = createContext<AgentControl | undefined>(
  undefined,
);
const empty: readonly AgentView[] = [];
const noSubscribe = () => () => {};
const noSnapshot = () => null;

export function sameCommunityAgents(
  agents: readonly AgentView[],
  scope: string,
) {
  const viewer = scope.slice(-64);
  if (!/^[0-9a-f]{64}$/.test(viewer)) return empty;
  return agents.filter(
    (agent) => `${relayOrigin(agent.relayUrl)}:${viewer}` === scope,
  );
}

/** Read the app-owned projection, never construct another native controller. */
export function useMentionAgents(scope: string) {
  const control = useContext(AgentMentionContext);
  const state = useSyncExternalStore(
    control?.subscribe ?? noSubscribe,
    control?.snapshot ?? noSnapshot,
  );
  useEffect(() => {
    if (control?.snapshot().status === "idle") void control.refresh();
  }, [control]);
  const agents =
    state?.status === "ready" ? (state.data?.agents ?? empty) : empty;
  return useMemo(
    () => ({ control, agents: sameCommunityAgents(agents, scope) }),
    [control, agents, scope],
  );
}
