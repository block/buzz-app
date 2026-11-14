import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

const preferenceKey = "buzz-expand-nested-replies.v1";
const changedEvent = "buzz-expand-nested-replies-changed";
let unsavedPreference: boolean | undefined;

/** Device-local choice to show nested thread replies open. Off by default. */
export function expandNestedRepliesPreference(): boolean {
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
export function useExpandNestedRepliesPreference() {
  const enabled = useSyncExternalStore(
    subscribe,
    expandNestedRepliesPreference,
  );
  // Saving the same active choice changes recovery state, not its behavior.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { enabled, unsaved };
}
export function setExpandNestedRepliesPreference(enabled: boolean): void {
  unsavedPreference = enabled;
  try {
    localStorage.setItem(preferenceKey, enabled ? "on" : "off");
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** Showing nested thread replies open as a device setting. */
export const expandNestedRepliesSetting: DeviceSetting = {
  key: "conversations.expand_nested_replies",
  description:
    "Show replies to replies open in threads instead of behind View replies.",
  schema: { type: "boolean" },
  applies:
    "Open threads switch at once; branches you collapsed or opened yourself return to the new default.",
  read: () => ({
    value: expandNestedRepliesPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This choice is active, but could not be saved on this device.",
  }),
  write: (value) => setExpandNestedRepliesPreference(value as boolean),
};
