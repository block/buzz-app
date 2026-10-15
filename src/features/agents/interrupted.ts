// Mention turns that were working when the app closed or reloaded, for a type
// whose turns end with the page (`AgentType.resumes`), kept until the owner
// resumes or forgets them. Only each event's id and channel are saved; the
// event is read again from the relay.
import type { AgentStore } from "./store";

export const INTERRUPTED_KEY = "buzz.agents.interrupted.v1";

/** By agent, each mention it was working on: its event id, and its channel
 * or "" without one. */
export type Interrupted = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

const ID = /^[0-9a-f]{64}$/;

export function readInterrupted(storage: AgentStore): Interrupted {
  let stored: unknown;
  try {
    stored = JSON.parse(storage.get(INTERRUPTED_KEY) ?? "null");
  } catch {
    return {};
  }
  if (!stored || typeof stored !== "object") return {};
  const turns: Record<string, Record<string, string>> = {};
  for (const [pubkey, value] of Object.entries(stored)) {
    if (!ID.test(pubkey) || !value || typeof value !== "object") continue;
    const ids = Object.entries(value).filter(
      (entry): entry is [string, string] =>
        ID.test(entry[0]) && typeof entry[1] === "string",
    );
    if (ids.length) turns[pubkey] = Object.fromEntries(ids);
  }
  return turns;
}

/** Settles once the write is saved; rejects when storage refuses it. */
export function writeInterrupted(storage: AgentStore, turns: Interrupted) {
  return storage.set(
    INTERRUPTED_KEY,
    Object.keys(turns).length ? JSON.stringify(turns) : null,
  );
}
