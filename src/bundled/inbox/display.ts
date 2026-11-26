/** Where Activity shows: its page, its sidebar card, or both. */
export type ActivityDisplay = "both" | "page" | "card";
export const activityDisplays: readonly (readonly [ActivityDisplay, string])[] =
  [
    ["both", "Page and sidebar card"],
    ["page", "Page only"],
    ["card", "Sidebar card only"],
  ];
export const ACTIVITY_DISPLAY_KEY = "buzz-activity-display.v1";
export const DEFAULT_DISPLAY: ActivityDisplay = "both";

const isDisplay = (value: unknown): value is ActivityDisplay =>
  activityDisplays.some(([display]) => display === value);

export const showsPage = (display: ActivityDisplay) => display !== "card";
export const showsCard = (display: ActivityDisplay) => display !== "page";

/** Activity's display choice, kept on this device and shared across windows. */
export function createDisplay(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
) {
  let current = DEFAULT_DISPLAY;
  let error: string | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const restore = () => {
    try {
      const saved = host?.localStorage.getItem(ACTIVITY_DISPLAY_KEY);
      current = isDisplay(saved) ? saved : DEFAULT_DISPLAY;
    } catch {
      current = DEFAULT_DISPLAY;
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (
      event.storageArea === host?.localStorage &&
      event.key === ACTIVITY_DISPLAY_KEY
    ) {
      restore();
      notify();
    }
  };
  host?.addEventListener("storage", onStorage);
  restore();
  return {
    snapshot: () => current,
    error: () => error,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(display: ActivityDisplay) {
      if (display === current) return;
      current = display;
      error = null;
      try {
        host?.localStorage.setItem(ACTIVITY_DISPLAY_KEY, display);
      } catch {
        error = "This choice couldn't be saved on this device.";
      }
      notify();
    },
    dispose() {
      host?.removeEventListener("storage", onStorage);
      listeners.clear();
    },
  };
}

export type Display = ReturnType<typeof createDisplay>;
