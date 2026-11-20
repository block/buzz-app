import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

const preferenceKey = "buzz-agents-lean-base-prompt.v1";
const changedEvent = "buzz-agents-lean-base-prompt-changed";
let unsavedPreference: boolean | undefined;

/** Device-local choice to give agents the lean base prompt: the Buzz
 * required contract without the optional guidance. On by default.
 * Claude/Codex keep it until a new session; Goose/Pi refresh it on the next turn. */
export function leanBasePromptPreference(): boolean {
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
export function useLeanBasePromptPreference() {
  return useSyncExternalStore(subscribe, leanBasePromptPreference);
}
function saveError(): string | null {
  return unsavedPreference === undefined
    ? null
    : "This choice is active, but could not be saved on this device. Try again.";
}
export function useLeanBasePromptSaveError() {
  return useSyncExternalStore(subscribe, saveError);
}
export function setLeanBasePromptPreference(enabled: boolean): string | null {
  let error: string | null = null;
  unsavedPreference = enabled;
  try {
    localStorage.setItem(preferenceKey, enabled ? "on" : "off");
    unsavedPreference = undefined;
  } catch {
    error =
      "This choice is active, but could not be saved on this device. Try again.";
  }
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(changedEvent));
  return error;
}

/** The lean base prompt as a device setting. */
export const leanBasePromptSetting: DeviceSetting = {
  key: "agents.lean_base_prompt",
  description:
    "Device-wide for agents using the shared Buzz prompt; any connected agent with settings access can change it. On (default) omits optional workflow guidance; off includes full guidance. Claude/Codex need a new session; Goose/Pi apply it next turn.",
  schema: { type: "boolean" },
  read: () => ({
    value: leanBasePromptPreference(),
    unsaved: saveError(),
  }),
  write: (value) => {
    setLeanBasePromptPreference(value as boolean);
  },
};
