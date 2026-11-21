import { createContext, useContext } from "react";
import type { OpenAttempt } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import type { RelaySession } from "../../features/relay/session";

export const BESTIE_PAGE = "buzz.bestie/bestie";
/** Whether `target` is the Bestie page, which presents the promoted DM. */
export function isBestiePage(target: OpenTarget | null | undefined) {
  return (
    target?.kind === "page" &&
    `${target.pluginId}/${target.pageId}` === BESTIE_PAGE
  );
}
export type BestieMark = {
  label: string;
  detail: "Bestie";
  avatar?: { src: string | undefined; shape: "squircle" };
  placeholder?: true;
};
export const BestieNavigationContext = createContext<BestieMark | undefined>(
  undefined,
);
export const BestieConversationContext = createContext<
  { session: RelaySession; channelId: string } | undefined
>(undefined);

export function useBestieConversation(session: RelaySession | undefined) {
  const conversation = useContext(BestieConversationContext);
  return session && conversation?.session === session
    ? conversation.channelId
    : undefined;
}

/**
 * A one-shot ask, from the dock, to put the cursor in the Bestie conversation
 * composer once this exact open lands. Bestie consumes it only while every
 * check still holds, and the composer checks again right before focusing.
 */
export type BestieFocusRequest = Readonly<{
  attempt: OpenAttempt;
  session: RelaySession;
  channelId: string;
  /** The press-time viewer, community and relay session still apply. */
  inScope(): boolean;
  /** A click, key or focus move after the press. */
  cancelled(): boolean;
  /** `performance.now()` deadline. */
  expires: number;
}>;

let focusRequest: BestieFocusRequest | undefined;
const focusListeners = new Set<() => void>();
const publishFocusRequest = (next: BestieFocusRequest | undefined) => {
  focusRequest = next;
  for (const listener of [...focusListeners]) listener();
};
export const bestieFocusRequests = {
  snapshot: () => focusRequest,
  subscribe(listener: () => void) {
    focusListeners.add(listener);
    return () => {
      focusListeners.delete(listener);
    };
  },
  /** Replaces any earlier request; it clears itself on abort or expiry. */
  post(request: BestieFocusRequest) {
    publishFocusRequest(request);
    const clear = () => bestieFocusRequests.clear(request);
    request.attempt.signal.addEventListener("abort", clear, { once: true });
    setTimeout(clear, Math.max(0, request.expires - performance.now()));
  },
  /** Clears `request`, or whatever is posted when omitted. */
  clear(request?: BestieFocusRequest) {
    if (focusRequest && (!request || focusRequest === request))
      publishFocusRequest(undefined);
  },
};
