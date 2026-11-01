import { useSyncExternalStore } from "react";

const preferenceKey = "buzz-github-links-in-browser.v1";
const changedEvent = "buzz-github-links-in-browser-changed";
let unsavedPreference: boolean | undefined;

export function githubLinksOpenInBrowserPreference(): boolean {
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

export function useGitHubLinksOpenInBrowserPreference() {
  const enabled = useSyncExternalStore(
    subscribe,
    githubLinksOpenInBrowserPreference,
  );
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { enabled, unsaved };
}

export function setGitHubLinksOpenInBrowserPreference(enabled: boolean): void {
  unsavedPreference = enabled;
  try {
    localStorage.setItem(preferenceKey, enabled ? "on" : "off");
    unsavedPreference = undefined;
  } catch {
    // Keep the current session's choice active and expose its save recovery.
  }
  window.dispatchEvent(new Event(changedEvent));
}

export function isGitHubLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname === "github.com"
    );
  } catch {
    return false;
  }
}
