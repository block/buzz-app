// Each ACP agent's saved conversations on this device: when each was last
// active and, once its first prompt succeeded, the harness session to resume
// and how far it has seen. Resume pointers never sync.
import {
  SAVED_SESSIONS,
  type SavedConversation,
  savedConversation,
  type SessionStore,
} from "../../features/agent-harness/acp/agent-sessions";

export const SESSIONS_KEY = "buzz.acp.sessions.v1";
/** Saved conversations per agent; the least recently used are forgotten. */
const SAVED_LIMIT = 200;

type All = Record<string, Record<string, SavedConversation>>;

/** One agent's saved conversations in `storage`. */
export function localSessions(
  storage: Storage,
  agent: string,
): Required<SessionStore> & {
  /** Saved conversations, most recently used first. */
  list(): [string, SavedConversation][];
  /** Adds a session opened for `key` to its history, newest first. The
   * history is only for reading back: it never moves the resume pointer. */
  remember(key: string, id: string): void;
} {
  const readAll = (): All => {
    try {
      const value = JSON.parse(storage.getItem(SESSIONS_KEY) ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  const sorted = (saved: Record<string, SavedConversation> = {}) =>
    Object.entries(saved)
      .filter(([, conversation]) => typeof conversation?.at === "number")
      .sort(([, a], [, b]) => b.at - a.at);
  const write = (edit: (saved: Record<string, SavedConversation>) => void) => {
    const all = readAll();
    const saved = { ...all[agent] };
    edit(saved);
    all[agent] = Object.fromEntries(sorted(saved).slice(0, SAVED_LIMIT));
    try {
      storage.setItem(SESSIONS_KEY, JSON.stringify(all));
    } catch (error) {
      console.warn("ACP sessions were not saved", error);
    }
  };
  const load = (key: string) => readAll()[agent]?.[key];
  /** `saved`'s history, validated and bounded. It takes in the resume
   * pointer, which a conversation saved before history was kept has alone. */
  const history = (saved: SavedConversation | undefined) => {
    const valid = savedConversation(saved);
    const sessions = valid
      ? savedConversation({
          at: valid.at,
          sessions: [...(valid.sessions ?? []), saved?.id],
        })?.sessions
      : undefined;
    return sessions?.length ? { sessions } : {};
  };
  return {
    list: () => sorted(readAll()[agent]),
    get: load,
    load,
    set: (key, conversation) =>
      write((saved) => {
        saved[key] = conversation;
      }),
    remember: (key, id) =>
      write((saved) => {
        const old = saved[key];
        const kept = history(old).sessions ?? [];
        saved[key] = {
          ...old,
          at: old?.at ?? Date.now(),
          sessions: [id, ...kept.filter((other) => other !== id)].slice(
            0,
            SAVED_SESSIONS,
          ),
        };
      }),
    touch: (key, at) =>
      write((saved) => {
        saved[key] = { ...saved[key], at };
      }),
    advance: (key, { id, covered, context, overridden }) =>
      write((saved) => {
        const old = saved[key];
        const at = old?.at ?? Date.now();
        // A first success writes the pointer; later ones of the same session
        // move only its coverage, and flags only ever turn on.
        saved[key] =
          old?.id === id
            ? {
                ...old,
                at,
                covered,
                overridden: {
                  model: Boolean(old.overridden?.model || overridden.model),
                  effort: Boolean(old.overridden?.effort || overridden.effort),
                },
              }
            : { at, id, covered, context, overridden, ...history(old) };
      }),
    drop: (key) =>
      write((saved) => {
        const old = saved[key];
        // The conversation stays listed with its history; only its pointer
        // goes.
        if (old) saved[key] = { at: old.at, ...history(old) };
      }),
  };
}

export const OWED_KEY = "buzz.acp.owed.v1";
/** Owed messages kept per conversation, and conversations kept in all; the
 * least recently updated go first. */
const OWED_LIMIT = 256;
const OWED_CONVERSATIONS = 64;

/** One agent's owed messages in `storage`: per conversation, the events whose
 * turn failed, which later prompts carry even below the session's mark. */
export function localOwed(storage: Storage, agent: string) {
  const prefix = `${agent}/`;
  const readAll = (): Record<string, string[]> => {
    try {
      const value = JSON.parse(storage.getItem(OWED_KEY) ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  return {
    get: (key: string): readonly string[] => {
      const ids = readAll()[prefix + key];
      return Array.isArray(ids) ? ids : [];
    },
    set: (key: string, ids: readonly string[]) => {
      const all = readAll();
      delete all[prefix + key];
      if (ids.length) all[prefix + key] = ids.slice(-OWED_LIMIT);
      for (const stale of Object.keys(all).slice(0, -OWED_CONVERSATIONS))
        delete all[stale];
      try {
        storage.setItem(OWED_KEY, JSON.stringify(all));
      } catch (error) {
        console.warn("ACP owed messages were not saved", error);
      }
    },
  };
}
