import type { InviteLink } from "./invite-link";

/** An OS invitation is an intent, never a membership or an authorization. */
export function createInviteIntent() {
  let current: (InviteLink & { viewer: string; requestId: number }) | undefined;
  let requestId = 0;
  const listeners = new Set<() => void>();
  const snapshot = () => current;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    snapshot,
    subscribe,
    open(invite: InviteLink, viewer: string) {
      current = { ...invite, viewer, requestId: ++requestId };
      emit();
    },
    clear(requestId?: number) {
      if (
        !current ||
        (requestId !== undefined && current.requestId !== requestId)
      )
        return;
      current = undefined;
      emit();
    },
  };
}
