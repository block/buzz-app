import { useSyncExternalStore } from "react";

/** Device-local choice: plain Up edits from an empty composer. Off by default. */
const preferenceKey = "buzz-edit-with-up-arrow.v1";
const changedEvent = "buzz-edit-with-up-arrow-changed";
let unsavedPreference: boolean | undefined;

export function editWithUpArrowPreference(): boolean {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) === "on";
  } catch {
    return false;
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
export function useEditWithUpArrowPreference() {
  return useSyncExternalStore(subscribe, editWithUpArrowPreference);
}
export function setEditWithUpArrowPreference(enabled: boolean): string | null {
  let error: string | null = null;
  unsavedPreference = enabled;
  try {
    localStorage.setItem(preferenceKey, enabled ? "on" : "off");
    unsavedPreference = undefined;
  } catch {
    error =
      "This choice is active, but could not be saved on this device. Try again.";
  }
  window.dispatchEvent(new Event(changedEvent));
  return error;
}
