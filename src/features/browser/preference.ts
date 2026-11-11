import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

export type WebsiteViewer = "buzz" | "browser";
const preferenceKey = "buzz-website-viewer.v1";
const changedEvent = "buzz-website-viewer-changed";
let unsavedPreference: WebsiteViewer | undefined;

/** Whether this device shows website links in Buzz's built-in viewer. */
export function websiteViewerPreference(): WebsiteViewer {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) === "browser"
      ? "browser"
      : "buzz";
  } catch {
    return "buzz";
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
export function useWebsiteViewerPreference() {
  const viewer = useSyncExternalStore(subscribe, websiteViewerPreference);
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { viewer, unsaved };
}
export function setWebsiteViewerPreference(value: WebsiteViewer): void {
  unsavedPreference = value;
  try {
    localStorage.setItem(preferenceKey, value);
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice across settings remounts, as thread placement.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** Website links as a device setting. */
export const websiteViewerSetting: DeviceSetting = {
  key: "links.website_viewer",
  description:
    "Open website links in Buzz's built-in viewer, or in your default browser.",
  schema: { type: "string", enum: ["buzz", "browser"] },
  applies:
    "Only links Buzz shows in its built-in website viewer, such as Builderlab apps. Other web links always open in your default browser.",
  read: () => ({
    value: websiteViewerPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This choice is active, but could not be saved on this device.",
  }),
  write: (value) => setWebsiteViewerPreference(value as WebsiteViewer),
};
