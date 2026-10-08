import { useSyncExternalStore } from "react";

const key = "buzz-show-channel-session-usage.v1";
const changedEvent = "buzz-show-channel-session-usage-changed";
let unsaved: boolean | undefined;

export function showChannelUsage(): boolean {
  if (unsaved !== undefined) return unsaved;
  try {
    return localStorage.getItem(key) !== "off";
  } catch {
    return false;
  }
}

function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== key && event.key !== null) return;
    unsaved = undefined;
    listener();
  };
  window.addEventListener(changedEvent, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changedEvent, listener);
    window.removeEventListener("storage", storage);
  };
}

export function useChannelUsagePreference() {
  return useSyncExternalStore(subscribe, showChannelUsage);
}

export function setChannelUsagePreference(enabled: boolean): string | null {
  let error: string | null = null;
  unsaved = enabled;
  try {
    localStorage.setItem(key, enabled ? "on" : "off");
    unsaved = undefined;
  } catch {
    error =
      "This choice is active, but could not be saved on this device. Try again.";
  }
  window.dispatchEvent(new Event(changedEvent));
  return error;
}
