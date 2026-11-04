import { useSyncExternalStore } from "react";

export type MessageSendKey = "enter" | "mod-enter";
const preferenceKey = "buzz-message-send-key.v1";
const changedEvent = "buzz-message-send-key-changed";
let unsavedPreference: MessageSendKey | undefined;

/** Device-local send key; Enter-to-send remains the default. */
export function messageSendKeyPreference(): MessageSendKey {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) === "mod-enter"
      ? "mod-enter"
      : "enter";
  } catch {
    return "enter";
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
export function useMessageSendKeyPreference() {
  const behavior = useSyncExternalStore(subscribe, messageSendKeyPreference);
  // Saving the same active choice changes recovery state, not its behavior.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { behavior, unsaved };
}
export function setMessageSendKeyPreference(value: MessageSendKey): void {
  unsavedPreference = value;
  try {
    localStorage.setItem(preferenceKey, value);
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}
