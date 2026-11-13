// The sessions that each local agent's one-off turns (a watch's or a timer's)
// started, kept so Usage can count them. Such a session's transcript names no
// conversation, so this record is the only sign that it is the agent's. It is
// kept apart from the saved prompts, which drop old sessions to stay small,
// and holds each session for `STANDALONE_DAYS` from its start: longer than
// Usage reads back.
import { validTime } from "../agent-harness/acp/agent-sessions";
import type { AgentKey } from "./membership";
import type { AgentStore } from "./store";

export const STANDALONE_PREFIX = "buzz.standalone-sessions.v1:";
/** Usage reads 30 days back, and a turn can answer a day after it started. */
export const STANDALONE_DAYS = 32;
/** Past this many, the oldest are dropped, so the value stays well under
 * agent storage's 4 MiB a value however often an agent's turns run. */
export const STANDALONE_LIMIT = 10_000;
const DAY = 86_400_000;

type Stored = { version: 1; sessions: [string, number][] };

const standaloneKey = (type: string, agent: AgentKey) =>
  `${STANDALONE_PREFIX}${type}:${agent}`;

/** The stored sessions, damaged entries dropped. */
function read(text: string | null): [string, number][] {
  try {
    const stored = JSON.parse(text ?? "null") as Partial<Stored> | null;
    if (stored?.version === 1 && Array.isArray(stored.sessions))
      return stored.sessions.filter(
        (entry): entry is [string, number] =>
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          entry[0].length > 0 &&
          entry[0].length <= 256 &&
          validTime(entry[1]),
      );
  } catch {}
  return [];
}

/** The sessions one agent's one-off turns started, of one agent type. */
export function standaloneSessions(
  storage: AgentStore,
  type: string,
  agent: AgentKey,
  now: () => number = Date.now,
) {
  const key = standaloneKey(type, agent);
  const kept = () => {
    const cutoff = now() - STANDALONE_DAYS * DAY;
    return read(storage.get(key)).filter(([, at]) => at >= cutoff);
  };
  return {
    /** The sessions kept, oldest first, with when each started. */
    list: () => kept().map(([id, at]) => ({ id, at })),
    /** Records a one-off turn's new session, dropping ones past keeping. A
     * failed save is logged, never thrown, so the agent keeps working. */
    async add(id: string) {
      try {
        // Read, changed and written with no wait between, so adds never
        // drop each other's sessions.
        const sessions = kept();
        if (sessions.some(([found]) => found === id)) return;
        sessions.push([id, now()]);
        await storage.set(
          key,
          JSON.stringify({
            version: 1,
            sessions: sessions.slice(-STANDALONE_LIMIT),
          } satisfies Stored),
        );
      } catch (error) {
        console.error("A one-off turn's session was not recorded", error);
      }
    },
  };
}

/** Removes a membership's one-off turn sessions, of every agent type. */
export async function removeStandaloneSessions(
  storage: AgentStore,
  agent: AgentKey,
) {
  for (const key of storage.keys())
    if (key.startsWith(STANDALONE_PREFIX) && key.endsWith(`:${agent}`))
      await storage.set(key, null);
}
