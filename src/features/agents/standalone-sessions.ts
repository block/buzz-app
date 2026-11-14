// The sessions that each local agent's one-off turns (a watch's or a timer's)
// started, kept so Usage can count them. Such a session's transcript names no
// conversation, so this record is the only sign that it is the agent's. It is
// kept apart from the saved prompts, which drop old sessions to stay small,
// and holds each session for `STANDALONE_DAYS` from its start: longer than
// Usage reads back. Each also keeps the key of the turn that started it
// (`timer/ID` or `watch/ID`), so Usage can say which routine spent it.
// Nothing inside that window is dropped, however often the agent's turns run.
//
// Each day's starts are a value of their own, so a turn rewrites only its
// day's value, and whole days past keeping are removed, every agent's of the
// turn's type. Removing an agent removes its days, except of a type whose
// harness deletes what its sessions left: those stay until past keeping, so
// it still can. Agent storage takes
// 4 MiB a value: about 70,000 starts in one day, far more than one timer's
// 1,440 at its shortest interval. A save past that fails and is logged.
import { validTime } from "../agent-harness/acp/agent-sessions";
import type { AgentKey } from "./membership";
import type { AgentStore } from "./store";

export const STANDALONE_PREFIX = "buzz.standalone-sessions.v1:";
/** Usage reads 30 days back, and a turn can answer a day after it started. */
export const STANDALONE_DAYS = 32;
const DAY = 86_400_000;

/** `[id, startedAt]`, or with the key of the turn that started it. */
type Entry = [string, number] | [string, number, string];
type Stored = { version: 1; sessions: Entry[] };

/** The key of an agent's sessions that started on `day` (days since 1970,
 * UTC), of one agent type. */
const dayKey = (type: string, agent: AgentKey, day: number) =>
  `${STANDALONE_PREFIX}${type}:${agent}:${day}`;

const short = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

/** The stored sessions, damaged entries dropped. */
function read(text: string | null): Entry[] {
  try {
    const stored = JSON.parse(text ?? "null") as Partial<Stored> | null;
    if (stored?.version === 1 && Array.isArray(stored.sessions))
      return stored.sessions.filter(
        (entry): entry is Entry =>
          Array.isArray(entry) &&
          short(entry[0]) &&
          validTime(entry[1]) &&
          (entry.length === 2 || (entry.length === 3 && short(entry[2]))),
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
  const prefix = dayKey(type, agent, 0).slice(0, -1);
  const typePrefix = `${STANDALONE_PREFIX}${type}:`;
  /** The stored days, each with its key: the agent's, or with `every`, those
   * of every agent of the type, removed ones too. */
  const days = (every = false) =>
    storage.keys().flatMap((key) => {
      const day = every
        ? /^[^:]+:(\d{1,9})$/.exec(key.slice(typePrefix.length))?.[1]
        : key.slice(prefix.length);
      return key.startsWith(every ? typePrefix : prefix) &&
        day &&
        /^\d{1,9}$/.test(day)
        ? [{ key, day: Number(day) }]
        : [];
    });
  const cutoff = () => now() - STANDALONE_DAYS * DAY;
  const kept = () => {
    const after = cutoff();
    return days()
      .flatMap(({ key, day }) =>
        (day + 1) * DAY <= after ? [] : read(storage.get(key)),
      )
      .filter(([, at]) => at >= after)
      .sort((a, b) => a[1] - b[1]);
  };
  return {
    /** The sessions kept, oldest first, with when each started and the key
     * of the turn that started it, when that was recorded. */
    list: () =>
      kept().map(([id, at, wake]) => (wake ? { id, at, wake } : { id, at })),
    /** Records a one-off turn's new session, and the turn's key when given,
     * then removes the days past keeping, of every agent of the type. With
     * `drop`, a day is removed only
     * once `drop` has removed what its sessions left behind, such as their
     * transcripts; a day `drop` fails for stays, unlisted, for the next add
     * to try again. A failed save or drop is logged, never thrown, so the
     * agent keeps working. */
    async add(
      id: string,
      wake?: string,
      drop?: (ids: string[]) => Promise<void>,
    ) {
      try {
        // Read, changed and written with no wait between, so adds never
        // drop each other's sessions.
        if (kept().some(([found]) => found === id)) return;
        const at = now();
        const key = dayKey(type, agent, Math.floor(at / DAY));
        const sessions = read(storage.get(key));
        sessions.push(short(wake) ? [id, at, wake] : [id, at]);
        const after = cutoff();
        // Every agent's of the type: a removed agent's record stays until
        // its days pass, so what they left can still be dropped.
        const past = days(true).filter(({ day }) => (day + 1) * DAY <= after);
        await storage.set(
          key,
          JSON.stringify({ version: 1, sessions } satisfies Stored),
        );
        for (const { key } of past) {
          if (drop) {
            const ids = read(storage.get(key)).map(([found]) => found);
            try {
              if (ids.length) await drop(ids);
            } catch (error) {
              console.error("A past day's one-off sessions were kept", error);
              continue;
            }
          }
          await storage.set(key, null);
        }
      } catch (error) {
        console.error("A one-off turn's session was not recorded", error);
      }
    },
  };
}

/** Removes a membership's one-off turn sessions, of every agent type but
 * those in `keep`: a type whose harness deletes what its sessions left, as
 * Codex deletes their threads, keeps a removed agent's days, which the next
 * one-off turn of any agent of the type removes once past keeping. */
export async function removeStandaloneSessions(
  storage: AgentStore,
  agent: AgentKey,
  keep: readonly string[] = ["codex"],
) {
  for (const key of storage.keys()) {
    if (!key.startsWith(STANDALONE_PREFIX)) continue;
    const [type = "", owner] = key.slice(STANDALONE_PREFIX.length).split(":");
    if (owner === agent && !keep.includes(type)) await storage.set(key, null);
  }
}
