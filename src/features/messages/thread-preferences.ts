import { useSyncExternalStore } from "react";
import type { DeviceSetting } from "../../shared/device-settings";

/** inline reads a new thread over its conversation's composer; main and
 * side open it in a tab in that pane. */
export type ThreadPlacement = "inline" | "main" | "side";
const preferenceKey = "buzz-thread-placement.v1";
const changedEvent = "buzz-thread-placement-changed";
let unsavedPreference: ThreadPlacement | undefined;

/** Device-local default for new tabs, never an instruction to move existing ones. */
export function threadPlacementPreference(): ThreadPlacement {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    const saved = localStorage.getItem(preferenceKey);
    return saved === "main" || saved === "inline" ? saved : "side";
  } catch {
    return "side";
  }
}
/** The pane a new thread tab opens in. Inline is not a pane: a thread that
 * still opens as a tab, as a link does, opens in the side pane. */
export function threadTabPane(): "main" | "side" {
  return threadPlacementPreference() === "main" ? "main" : "side";
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
export function useThreadPlacementPreference() {
  const placement = useSyncExternalStore(subscribe, threadPlacementPreference);
  // Saving the same active choice changes recovery state, not its placement.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { placement, unsaved };
}
export function setThreadPlacementPreference(value: ThreadPlacement): void {
  unsavedPreference = value;
  try {
    localStorage.setItem(preferenceKey, value);
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}

/** Thread placement as a device setting. */
export const threadPlacementSetting: DeviceSetting = {
  key: "conversations.thread_placement",
  description:
    "Where new threads open: inline over the conversation, or in a tab in the side pane or the main pane.",
  schema: { type: "string", enum: ["side", "main", "inline"] },
  applies:
    "New threads only; open threads stay where they are, Solo threads always open in the side pane, and thread links open as tabs.",
  read: () => ({
    value: threadPlacementPreference(),
    unsaved:
      unsavedPreference === undefined
        ? null
        : "This placement is active, but could not be saved on this device.",
  }),
  write: (value) => setThreadPlacementPreference(value as ThreadPlacement),
};
