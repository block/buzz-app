/**
 * A request to open one registered message action on one message, made from
 * outside the row (a pop-out window handing the action to the main window).
 * The row that shows that message in that scope consumes it: a dialog action
 * opens, a menu-placement action opens the message's menu with the action
 * visible. One request at a time; an unconsumed request expires.
 */
export type MessageActionRequest = Readonly<{
  scope: string;
  channelId: string;
  messageId: string;
  /** The exact contribution instance chosen. */
  key: string;
  revision: string;
}>;
const TTL_MS = 15_000;
let pending: { request: MessageActionRequest; until: number } | undefined;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
export const messageActionRequests = {
  request(next: MessageActionRequest) {
    pending = { request: next, until: Date.now() + TTL_MS };
    emit();
  },
  snapshot(): MessageActionRequest | undefined {
    if (pending && pending.until < Date.now()) pending = undefined;
    return pending?.request;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** The row showing this message takes the request; nobody else sees it. */
  take(scope: string, channelId: string, messageId: string) {
    const current = messageActionRequests.snapshot();
    if (
      !current ||
      current.scope !== scope ||
      current.channelId !== channelId ||
      current.messageId !== messageId
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
