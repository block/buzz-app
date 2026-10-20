import { useSyncExternalStore } from "react";

const SAVE_ERROR =
  "This choice is active, but could not be saved on this device. Try again.";

/**
 * An on/off choice stored on this device. A choice that fails to save stays
 * active in memory until another window changes the stored value.
 */
export function createDeviceToggle({
  storageKey,
  enabledByDefault,
}: {
  storageKey: string;
  enabledByDefault: boolean;
}) {
  const changedEvent = `${storageKey}-changed`;
  let unsavedChoice: boolean | undefined;

  function isEnabled(): boolean {
    if (unsavedChoice !== undefined) return unsavedChoice;
    try {
      const stored = localStorage.getItem(storageKey);
      return enabledByDefault ? stored !== "off" : stored === "on";
    } catch {
      return false;
    }
  }
  function subscribe(listener: () => void) {
    const storage = (event: StorageEvent) => {
      if (event.key !== storageKey && event.key !== null) return;
      unsavedChoice = undefined;
      listener();
    };
    window.addEventListener(changedEvent, listener);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(changedEvent, listener);
      window.removeEventListener("storage", storage);
    };
  }
  function useEnabled() {
    return useSyncExternalStore(subscribe, isEnabled);
  }
  /** Returns a message when the choice applied but could not be saved. */
  function setEnabled(enabled: boolean): string | null {
    let error: string | null = null;
    unsavedChoice = enabled;
    try {
      localStorage.setItem(storageKey, enabled ? "on" : "off");
      unsavedChoice = undefined;
    } catch {
      error = SAVE_ERROR;
    }
    window.dispatchEvent(new Event(changedEvent));
    return error;
  }

  return { isEnabled, useEnabled, setEnabled };
}
