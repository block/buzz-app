import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

const preferenceKey = "buzz-membership-rows.v1";
const changedEvent = "buzz-membership-rows-changed";
let unsavedPreference: boolean | undefined;

/** Device-local choice to show membership rows ("Sam was added by Alex")
 * in conversations. Hidden rows leave no day divider behind. */
export function membershipRowsPreference(): boolean {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) !== "off";
  } catch {
    return true;
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
export function useMembershipRowsPreference() {
  const enabled = useSyncExternalStore(subscribe, membershipRowsPreference);
  // Saving the same active choice changes recovery state, not its behavior.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { enabled, unsaved };
}
export function setMembershipRowsPreference(enabled: boolean): void {
  unsavedPreference = enabled;
  try {
    localStorage.setItem(preferenceKey, enabled ? "on" : "off");
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** Showing membership rows in conversations as a device setting. */
export const membershipRowsSetting: DeviceSetting = {
  key: "conversations.show_membership",
  description:
    "Shows when people and agents are added to or removed from a conversation.",
  schema: { type: "boolean" },
  read: () => ({
    value: membershipRowsPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This choice is active, but could not be saved on this device.",
  }),
  write: (value) => setMembershipRowsPreference(value as boolean),
};
