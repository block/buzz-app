import { useSyncExternalStore } from "react";
import type { SidebarSectionLayouts } from "../../features/channel-navigation/sidebar-sections-service";

/** How the sidebar's Activity card lays out its rows: two lines with the
 * message, or one line per conversation. Kept on this device and shared
 * across windows. */
const ACTIVITY_LAYOUT_KEY = "buzz-activity-layout.v1";
export type ActivityLayout = "default" | "compact";

const listeners = new Set<() => void>();
const read = (): ActivityLayout => {
  try {
    return globalThis.localStorage?.getItem(ACTIVITY_LAYOUT_KEY) === "compact"
      ? "compact"
      : "default";
  } catch {
    return "default";
  }
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === ACTIVITY_LAYOUT_KEY) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
};
const select = (id: string) => {
  try {
    if (id === "compact")
      globalThis.localStorage?.setItem(ACTIVITY_LAYOUT_KEY, "compact");
    else globalThis.localStorage?.removeItem(ACTIVITY_LAYOUT_KEY);
  } catch {
    // The choice holds for this window only.
  }
  for (const listener of listeners) listener();
};

export const activityLayouts: SidebarSectionLayouts = {
  options: [
    { id: "default", label: "Default" },
    { id: "compact", label: "Compact" },
  ],
  snapshot: read,
  subscribe,
  select,
};

export const useActivityLayout = () =>
  useSyncExternalStore(subscribe, read, () => "default" as const);
