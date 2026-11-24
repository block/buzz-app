// Mention turns that were working when the app closed or reloaded, for a type
// whose turns end with the page (`AgentType.resumes`), kept until the owner
// resumes or forgets them. The event is read again from the relay. Each agent
// membership has its own key, so a program writes only the agents it changed.
import { AGENT_KEY, type AgentKey } from "./membership";
import type { AgentStore } from "./store";

export const INTERRUPTED_PREFIX = "buzz.agents.interrupted.v1:";

/** A channel string, including legacy records, keeps native placement.
 * Pending work can still route; any accepted task has its own saved route. */
export type InterruptedEntry =
  | string
  | Readonly<{ channel: string; placement: "pending" }>;
export type InterruptedTurns = Readonly<Record<string, InterruptedEntry>>;
export type Interrupted = Readonly<Record<string, InterruptedTurns>>;

export type RunnerAbortReason =
  | "plugin-type-change"
  | "type-migration"
  | "protection-change"
  | "reload-lost"
  | "retire";

export type DrainUnavailableAction = "retain" | "pause" | "drop";

/** Why reconcile() aborts a runner, or undefined when nothing changed. */
export function reconcileAbortReason(
  input: Readonly<{
    previousTypeKey: string;
    nextTypeKey: string;
    sameTypeInstance: boolean;
    sameProtection: boolean;
  }>,
) {
  if (input.sameTypeInstance && input.sameProtection) return undefined;
  if (!input.sameProtection) return "protection-change" as const;
  if (input.previousTypeKey !== input.nextTypeKey)
    return "type-migration" as const;
  return "plugin-type-change" as const;
}

/** Whether an aborted resumable turn stays marked for owner resume. */
export function preservesInterruptedTurn(
  abortReason: RunnerAbortReason | undefined,
  resumable: boolean,
) {
  return resumable && abortReason === "plugin-type-change";
}

/** Adds or updates one interrupted turn record for an agent. */
export function recordInterruptedTurn(
  map: Interrupted,
  key: AgentKey,
  id: string,
  entry: InterruptedEntry,
) {
  return {
    ...map,
    [key]: { ...map[key], [id]: entry },
  } satisfies Interrupted;
}

/** What drain() does with custody and queues when a runner cannot start turns. */
export function drainUnavailableAction(
  input: Readonly<{
    agentReady: boolean;
    hasType: boolean;
    canRun: boolean;
    retained: boolean;
  }>,
) {
  if (!input.agentReady) {
    return (
      input.hasType && input.canRun && input.retained ? "retain" : "pause"
    ) satisfies DrainUnavailableAction;
  }
  if (!input.hasType) return "pause" as const;
  return (input.canRun ? "retain" : "drop") satisfies DrainUnavailableAction;
}

const ID = /^[0-9a-f]{64}$/;

function interruptedEntry(value: unknown): value is InterruptedEntry {
  return (
    typeof value === "string" ||
    (!!value &&
      typeof value === "object" &&
      "channel" in value &&
      typeof value.channel === "string" &&
      "placement" in value &&
      value.placement === "pending")
  );
}

export function interruptedChannels(turns: InterruptedTurns = {}) {
  return Object.fromEntries(
    Object.entries(turns).map(([id, turn]) => [
      id,
      typeof turn === "string" ? turn : turn.channel,
    ]),
  );
}

export function readInterrupted(storage: AgentStore): Interrupted {
  const turns: Record<string, InterruptedTurns> = {};
  for (const key of storage.keys()) {
    if (!key.startsWith(INTERRUPTED_PREFIX)) continue;
    const agent = key.slice(INTERRUPTED_PREFIX.length);
    let stored: unknown;
    try {
      stored = JSON.parse(storage.get(key) ?? "null");
    } catch {
      continue;
    }
    if (!AGENT_KEY.test(agent) || !stored || typeof stored !== "object")
      continue;
    const ids = Object.entries(stored).filter(
      (entry): entry is [string, InterruptedEntry] =>
        ID.test(entry[0]) && interruptedEntry(entry[1]),
    );
    if (ids.length) turns[agent] = Object.fromEntries(ids);
  }
  return turns;
}

/** Saves a membership's turns in its own key. Settles once the write is
 * saved; rejects when storage refuses it. */
export function writeInterrupted(
  storage: AgentStore,
  agent: AgentKey,
  turns: InterruptedTurns,
) {
  return storage.set(
    `${INTERRUPTED_PREFIX}${agent}`,
    Object.keys(turns).length ? JSON.stringify(turns) : null,
  );
}
