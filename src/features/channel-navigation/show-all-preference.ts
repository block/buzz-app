import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

/** The durations Settings offers for Show all conversations, in seconds. */
export const SHOW_ALL_PRESETS = [30, 60, 120, 300] as const;
export const DEFAULT_SHOW_ALL_SECONDS = 120;
const preferenceKey = "buzz-show-all-duration.v1";
const changedEvent = "buzz-show-all-duration-changed";
let unsavedPreference: number | undefined;

/** Device-local length of Show all conversations, in whole seconds. Any saved
 * whole number up to an hour is honored; Settings offers only the presets. */
export function showAllSecondsPreference(): number {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    const saved = Number(localStorage.getItem(preferenceKey));
    return Number.isInteger(saved) && saved >= 1 && saved <= 3600
      ? saved
      : DEFAULT_SHOW_ALL_SECONDS;
  } catch {
    return DEFAULT_SHOW_ALL_SECONDS;
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
export function useShowAllSecondsPreference() {
  const seconds = useSyncExternalStore(subscribe, showAllSecondsPreference);
  // Saving the same active choice changes recovery state, not its behavior.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { seconds, unsaved };
}
export function setShowAllSecondsPreference(seconds: number): void {
  unsavedPreference = seconds;
  try {
    localStorage.setItem(preferenceKey, String(seconds));
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** How long Show all conversations lasts, as a device setting. */
export const showAllSecondsSetting: DeviceSetting = {
  key: "sidebar.show_all_seconds",
  description:
    "How long Show all conversations pauses the sidebar's section filters, in seconds.",
  schema: { type: "integer", minimum: 30, maximum: 300, multipleOf: 30 },
  read: () => ({
    value: showAllSecondsPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This duration is active, but could not be saved on this device.",
  }),
  write: (value) => setShowAllSecondsPreference(value as number),
};
