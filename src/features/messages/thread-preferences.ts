import { useSyncExternalStore } from "react";

export type ThreadPlacement = "main" | "side";
const preferenceKey = "buzz-thread-placement.v1";
const changedEvent = "buzz-thread-placement-changed";
let unsavedPreference: ThreadPlacement | undefined;

/** Device-local default for new tabs, never an instruction to move existing ones. */
export function threadPlacementPreference(): ThreadPlacement {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) === "main" ? "main" : "side";
  } catch {
    return "side";
  }
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== preferenceKey && event.key !== null) return;
    unsavedPreference = undefined;
    listener();
  };
  window.addEventListener(changedEvent, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changedEvent, listener);
    window.removeEventListener("storage", storage);
  };
}
export function useThreadPlacementPreference() {
  return useSyncExternalStore(subscribe, threadPlacementPreference);
}
export function setThreadPlacementPreference(
  value: ThreadPlacement,
): string | null {
  let error: string | null = null;
  unsavedPreference = value;
  try {
    localStorage.setItem(preferenceKey, value);
    unsavedPreference = undefined;
  } catch {
    error =
      "This choice is active, but could not be saved on this device. Try again.";
  }
  window.dispatchEvent(new Event(changedEvent));
  return error;
}
