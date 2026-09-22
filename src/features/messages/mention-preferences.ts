import { useSyncExternalStore } from "react";

const preferenceKey = "buzz-remember-mentioned-agents.v1";
const changedEvent = "buzz-remember-mentioned-agents-changed";
let unsavedPreference: boolean | undefined;

export function rememberAgentsPreference(): boolean {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) !== "off";
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
export function useRememberAgentsPreference() {
  return useSyncExternalStore(subscribe, rememberAgentsPreference);
}
export function setRememberAgentsPreference(enabled: boolean): string | null {
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
