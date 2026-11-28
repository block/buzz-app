import { useCallback, useSyncExternalStore } from "react";
import { openingBlocked } from "./general-access";

type Session = Parameters<typeof openingBlocked>[0] & {
  profiles: { subscribe(listener: () => void): () => void };
  agentChoices: { subscribe(listener: () => void): () => void };
};

/** Re-evaluates on every profile or inventory notification. Ownership can be
 * verified after a profile arrives without changing the profile snapshot, so
 * subscribe to the result itself, not to either snapshot. */
export function useOpeningBlocked(
  session: Session,
  members: readonly string[] | undefined,
) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const profiles = session.profiles.subscribe(listener);
      const choices = session.agentChoices.subscribe(listener);
      return () => {
        profiles();
        choices();
      };
    },
    [session],
  );
  const blocked = () => openingBlocked(session, members);
  return useSyncExternalStore(subscribe, blocked, blocked);
}
