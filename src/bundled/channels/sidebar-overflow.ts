import { useSyncExternalStore } from "react";

/** Whether the sidebar lists Team, Direct messages and Solo: the cards that
 * hold every conversation not placed in a workspace or Favorites. Kept on
 * this device and shared across windows. Off, Command K holds them. */
export const SIDEBAR_OVERFLOW_KEY = "buzz-sidebar-overflow.v1";
/** The catch-all cards the choice hides. */
export const OVERFLOW_SECTIONS: ReadonlySet<string> = new Set([
  "channels",
  "dms",
  "solo",
]);

const listeners = new Set<() => void>();
const read = () => {
  try {
    return globalThis.localStorage?.getItem(SIDEBAR_OVERFLOW_KEY) !== "hidden";
  } catch {
    return true;
  }
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === SIDEBAR_OVERFLOW_KEY) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
};

export const useShowsOverflow = () =>
  useSyncExternalStore(subscribe, read, () => true);

export function setShowsOverflow(shows: boolean) {
  try {
    if (shows) globalThis.localStorage?.removeItem(SIDEBAR_OVERFLOW_KEY);
    else globalThis.localStorage?.setItem(SIDEBAR_OVERFLOW_KEY, "hidden");
  } catch {
    // The choice holds for this window only.
  }
  for (const listener of listeners) listener();
}
