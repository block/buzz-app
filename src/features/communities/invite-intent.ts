import type { InviteLink } from "./invite-link";

/**
 * A request to open the join dialog on a community. `submitted` marks an
 * address the person already chose in the app, such as a community they just
 * created, so the dialog connects at once instead of waiting for Continue.
 */
export type JoinRequest = InviteLink & { submitted?: boolean };

/** Opens the join dialog on a community address the person chose in the app;
 * false when the address is not a community origin or no identity is ready to
 * join with, so the caller can hand the address off another way. */
export type CommunityJoin = {
  open(address: string): boolean;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Optional: older hosts do not provide it. */
    communityJoin?: CommunityJoin;
  }
}

/**
 * First run's claim on an OS invitation, while no identity exists for the join
 * dialog to act with. The deep-link owner offers each invitation it holds;
 * first run answers whether it took it, and decides that by its own state.
 * Registering an answer tells the owner to offer again.
 */
function createFirstRunInvites() {
  let handler: ((invite: InviteLink) => boolean) | undefined;
  const listeners = new Set<() => void>();
  return {
    offer: (invite: InviteLink) => handler?.(invite) ?? false,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    handle(next: (invite: InviteLink) => boolean) {
      handler = next;
      for (const listener of [...listeners]) listener();
      return () => {
        if (handler === next) handler = undefined;
      };
    },
  };
}

/** An OS invitation is an intent, never a membership or an authorization. */
export function createInviteIntent() {
  const firstRun = createFirstRunInvites();
  let current:
    | (JoinRequest & { viewer: string; requestId: number })
    | undefined;
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
    firstRun,
    snapshot,
    subscribe,
    open(invite: JoinRequest, viewer: string) {
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
