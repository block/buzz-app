import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

const preferenceKey = "buzz-single-thread.v1";
const changedEvent = "buzz-single-thread-changed";
let unsavedPreference: boolean | undefined;

/** Device-local choice to keep one thread tab open per conversation. */
export function singleThreadPreference(): boolean {
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
export function useSingleThreadPreference() {
  const enabled = useSyncExternalStore(subscribe, singleThreadPreference);
  // Saving the same active choice changes recovery state, not its behavior.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { enabled, unsaved };
}
export function setSingleThreadPreference(enabled: boolean): void {
  unsavedPreference = enabled;
  try {
    localStorage.setItem(preferenceKey, enabled ? "on" : "off");
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** Keeping one thread open per conversation as a device setting. */
export const singleThreadSetting: DeviceSetting = {
  key: "conversations.single_thread",
  description:
    "Opening a thread closes the conversation's other open thread tabs, so one thread is open at a time.",
  schema: { type: "boolean" },
  applies:
    "New thread tabs only; a thread that is already open is selected and nothing closes. Each conversation keeps its own tabs.",
  read: () => ({
    value: singleThreadPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This choice is active, but could not be saved on this device.",
  }),
  write: (value) => setSingleThreadPreference(value as boolean),
};
