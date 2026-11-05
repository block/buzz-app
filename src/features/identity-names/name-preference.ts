import { useSyncExternalStore } from "react";
import type { VerifiedProfile } from "../relay/verified-profile";

export type NamePreference = "display" | "full";
const preferenceKey = "buzz-name-preference.v1";
const changedEvent = "buzz-name-preference-changed";
let unsavedPreference: NamePreference | undefined;

/** Device-local presentation only; signed profiles keep their original names. */
export function namePreference(): NamePreference {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) === "full" ? "full" : "display";
  } catch {
    return "display";
  }
}

export function subscribeNamePreference(listener: () => void) {
  if (typeof window === "undefined") return () => {};
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

export function useNamePreference() {
  const preference = useSyncExternalStore(
    subscribeNamePreference,
    namePreference,
  );
  const unsaved = useSyncExternalStore(
    subscribeNamePreference,
    () => unsavedPreference !== undefined,
  );
  return { preference, unsaved };
}

export function setNamePreference(value: NamePreference): void {
  unsavedPreference = value;
  try {
    localStorage.setItem(preferenceKey, value);
    unsavedPreference = undefined;
  } catch {
    // Keep the active choice and offer saving it again in Settings.
  }
  window.dispatchEvent(new Event(changedEvent));
}

export function preferredVerifiedName(
  profile: VerifiedProfile,
  preference = namePreference(),
): string {
  return preference === "full"
    ? (profile.fullName ?? profile.displayName)
    : profile.displayName;
}
