import type { RelaySession } from "../relay/session";

const sessions = new WeakMap<RelaySession, number>();
let nextSession = 0;

/** Presentation lifetimes reset on retarget/reconnect; persisted intent uses stable scope alone. */
export function messageViewKey(
  session: RelaySession,
  ...identity: (string | undefined)[]
) {
  let generation = sessions.get(session);
  if (generation === undefined) {
    generation = ++nextSession;
    sessions.set(session, generation);
  }
  return JSON.stringify([generation, ...identity]);
}
