/**
 * A request to open one Solo chat's access (Share access) dialog, made from
 * outside its header — a pop-out window handing the control to the main
 * window, where the dialog lives. The main-view header showing that chat in
 * that session consumes it; one request at a time, and an unconsumed one
 * expires. Mirrors `messageActionRequests`.
 */
import type { RelaySession } from "../relay/session";

export type SoloAccessRequest = Readonly<{
  /** The exact session the handoff was made from: a replaced session for
   * the same scope is another conversation and does not take it. */
  session: RelaySession;
  scope: string;
  channelId: string;
}>;
const TTL_MS = 15_000;
let pending: { request: SoloAccessRequest; until: number } | undefined;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
export const soloAccessRequests = {
  request(next: SoloAccessRequest) {
    pending = { request: next, until: Date.now() + TTL_MS };
    emit();
  },
  snapshot(): SoloAccessRequest | undefined {
    if (pending && pending.until < Date.now()) pending = undefined;
    return pending?.request;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** The header showing this chat takes the request; nobody else sees it. */
  take(session: RelaySession, scope: string, channelId: string) {
    const current = soloAccessRequests.snapshot();
    if (
      !current ||
      current.session !== session ||
      current.scope !== scope ||
      current.channelId !== channelId
    )
      return undefined;
    pending = undefined;
    emit();
    return current;
  },
  clear() {
    pending = undefined;
    emit();
  },
};
