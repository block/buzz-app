import { useSyncExternalStore, useCallback } from "react";
import type { IdentityNameView } from "./service";
const noop = () => () => {};
const zero = () => 0;
/** The interface arrives through the captured session, never a global lookup. */
export function useIdentityNames(names: IdentityNameView | undefined) {
  const revision = useSyncExternalStore(
    names?.subscribe ?? noop,
    names?.snapshot ?? zero,
    zero,
  );
  return useCallback(
    (pubkey: string, fallback: string): string => {
      // Invalidate memoized labels and completion choices on name changes.
      void revision;
      return names?.resolve(pubkey, fallback) ?? fallback;
    },
    [names, revision],
  );
}
