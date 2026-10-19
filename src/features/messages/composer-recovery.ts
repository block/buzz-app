import type { MentionPicks } from "../relay/messages";
import type { RelaySession } from "../relay/session";
import type { ComposerSession } from "./composer-session";
import type { MentionDraft } from "./mention-draft";

type Session = ComposerSession | RelaySession;

/** Content handed back to a composer after a send it accepted did not go. Its
 * text is already in the composer's saved draft and its files in the
 * composer's attachment store; the notice tells a mounted composer to load
 * them. */
export type RecoveredSend = {
  draft: MentionDraft;
  picks?: MentionPicks;
  preparationError?: unknown;
};
const recoveryListeners = new WeakMap<
  Session,
  Map<string, Set<(recovered: RecoveredSend) => void>>
>();
// A recovery that no mounted composer consumed replays on remount. Only the
// unpersisted parts need it: the pick snapshot and a preparation failure. The
// saved draft and attachment store remain the owners of the recovered content.
const missedRecovery = new WeakMap<Session, Map<string, RecoveredSend>>();
export function peekMissedRecovery(session: Session, key: string) {
  return missedRecovery.get(session)?.get(key);
}
export function takeMissedRecovery(session: Session, key: string) {
  const byKey = missedRecovery.get(session);
  const recovered = byKey?.get(key);
  byKey?.delete(key);
  return recovered;
}
/** Tells the composer for `key` (`${scope}:${draftKey}`) that its saved draft
 * and attachments now hold `recovered`. */
export function notifyRecovered(
  session: Session,
  key: string,
  recovered: RecoveredSend,
) {
  let byKey = missedRecovery.get(session);
  if (!byKey) {
    byKey = new Map();
    missedRecovery.set(session, byKey);
  }
  byKey.set(key, recovered);
  for (const listener of recoveryListeners.get(session)?.get(key) ?? [])
    listener(recovered);
}
export function subscribeRecovery(
  session: Session,
  key: string,
  listener: (recovered: RecoveredSend) => void,
) {
  let byKey = recoveryListeners.get(session);
  if (!byKey) {
    byKey = new Map();
    recoveryListeners.set(session, byKey);
  }
  let listeners = byKey.get(key);
  if (!listeners) {
    listeners = new Set();
    byKey.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) byKey.delete(key);
  };
}
