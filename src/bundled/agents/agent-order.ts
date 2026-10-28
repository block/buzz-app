import { useCallback, useState, useSyncExternalStore } from "react";
import type { Agent } from "../../features/agents/service";
import {
  readView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";

const KEY = "agents:order";

/** Display order only: never changes the agent service, teams or main agent. */
export function useAgentOrder(
  scope: string | undefined,
  agents: readonly Agent[],
) {
  useSyncExternalStore(
    useCallback(
      (notify) => (scope ? subscribeView(scope, notify) : () => {}),
      [scope],
    ),
    () => (scope ? viewRevision(scope, KEY) : null),
  );
  const [error, setError] = useState("");
  const saved = scope ? readView<unknown>(scope, KEY, []) : [];
  const ranks = new Map(
    (Array.isArray(saved) ? saved : []).flatMap((key, index) =>
      typeof key === "string" && /^[0-9a-f]{64}$/.test(key)
        ? [[key, index] as const]
        : [],
    ),
  );
  const ordered = [...agents].sort(
    (a, b) =>
      (ranks.get(a.pubkey) ?? Infinity) - (ranks.get(b.pubkey) ?? Infinity),
  );
  const save = (next: readonly Agent[]) => {
    const saved =
      !!scope &&
      writeView(
        scope,
        KEY,
        next.map((agent) => agent.pubkey),
      );
    setError(
      saved
        ? ""
        : "The agent order couldn't be saved on this device. Try again.",
    );
    return saved;
  };
  return { ordered, save, error };
}

export function moveAgent(agents: readonly Agent[], from: number, to: number) {
  const next = [...agents];
  const [agent] = next.splice(from, 1);
  if (agent) next.splice(to, 0, agent);
  return next;
}
