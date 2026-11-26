import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

const preferenceKey = "buzz-search-device.v1";
const changedEvent = "buzz-search-device-changed";
let unsavedPreference: boolean | undefined;

/** Device-local choice to search messages this device already received
 * as you type, above the relay's results. Off until it has been tried. */
export function deviceSearchPreference(): boolean {
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
export function useDeviceSearchPreference() {
  const enabled = useSyncExternalStore(subscribe, deviceSearchPreference);
  // Saving the same active choice changes recovery state, not its behavior.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { enabled, unsaved };
}
export function setDeviceSearchPreference(enabled: boolean): void {
  unsavedPreference = enabled;
  try {
    localStorage.setItem(preferenceKey, enabled ? "on" : "off");
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** Searching this device's messages as you type, as a device setting. */
export const deviceSearchSetting: DeviceSetting = {
  key: "search.device_messages",
  description:
    "Search shows matching messages this device already received as you type, above the community's results.",
  schema: { type: "boolean" },
  read: () => ({
    value: deviceSearchPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This choice is active, but could not be saved on this device.",
  }),
  write: (value) => setDeviceSearchPreference(value as boolean),
};
