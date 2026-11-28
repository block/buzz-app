import type { Seen } from "../../../features/seen/service";

/** Set once when this account starts Buzz with no community to open, so the
 * welcome tour is for people new to Buzz, not everyone after an upgrade.
 * Other introductions can check it to stay out of a newcomer's way. */
export const newToBuzzKey = "buzz.shell/new-to-buzz";
/** Set once the welcome tour is finished or closed. */
export const welcomeTourKey = "buzz.shell/welcome-tour-1";

/** Marks this account as new to Buzz: the welcome tour is due. */
export function markNewToBuzz(seen: Seen) {
  if (seen.has(newToBuzzKey) === false) seen.mark(newToBuzzKey);
}

/** Search's "Take the Buzz tour" asks the shell to start it again. */
const listeners = new Set<() => void>();
export const welcomeTour = {
  start() {
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
