import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

const preferenceKey = "buzz-message-markup.v1";
const changedEvent = "buzz-message-markup-changed";
let unsavedPreference: boolean | undefined;

/**
 * Device-local opt-in to keep typed Markdown as source in the message
 * composer instead of converting it to formatting as it is typed.
 */
export function messageMarkupPreference(): boolean {
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
export function useMessageMarkupPreference() {
  const enabled = useSyncExternalStore(subscribe, messageMarkupPreference);
  // Saving the same active choice changes recovery state, not its behavior.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { enabled, unsaved };
}
export function setMessageMarkupPreference(enabled: boolean): void {
  unsavedPreference = enabled;
  try {
    localStorage.setItem(preferenceKey, enabled ? "on" : "off");
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** The composer's keep-Markdown-as-typed opt-in as a device setting. */
export const markupSetting: DeviceSetting = {
  key: "conversations.markup",
  description:
    "Keeps Markdown typed in the message box as raw text instead of formatting it as you type. Messages still show formatted.",
  schema: { type: "boolean" },
  applies: "In the message box, for new messages and edits.",
  read: () => ({
    value: messageMarkupPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This choice is active, but could not be saved on this device.",
  }),
  write: (value) => setMessageMarkupPreference(value as boolean),
};
