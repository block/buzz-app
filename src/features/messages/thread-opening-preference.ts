import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

export type ThreadOpening = "first" | "latest";
const preferenceKey = "buzz-thread-opening.v1";
const changedEvent = "buzz-thread-opening-changed";
let unsavedPreference: ThreadOpening | undefined;

/** Device-local initial reading position; mounted readers retain their place. */
export function threadOpeningPreference(): ThreadOpening {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) === "first" ? "first" : "latest";
  } catch {
    return "latest";
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
export function useThreadOpeningPreference() {
  const opening = useSyncExternalStore(subscribe, threadOpeningPreference);
  // Retrying the active choice can change only its recovery state.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { opening, unsaved };
}
export function setThreadOpeningPreference(value: ThreadOpening): void {
  unsavedPreference = value;
  try {
    localStorage.setItem(preferenceKey, value);
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** Initial thread reading position as a device setting. */
export const threadOpeningSetting: DeviceSetting = {
  key: "conversations.thread_opening",
  description:
    "Where newly opened threads start: the first message or the latest reply.",
  schema: { type: "string", enum: ["latest", "first"] },
  applies:
    "Newly opened threads only; exact-message links and saved reading positions take priority.",
  read: () => ({
    value: threadOpeningPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This starting position is active, but could not be saved on this device.",
  }),
  write: (value) => setThreadOpeningPreference(value as ThreadOpening),
};
