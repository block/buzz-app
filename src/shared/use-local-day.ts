import { useSyncExternalStore } from "react";

/**
 * The user's current local calendar day, for components whose text is relative
 * to today ("Today", "Yesterday at 9:05 AM"). Reading it subscribes the
 * component itself, so a label re-renders at local midnight even when its
 * parent row is memoized and nothing else changes.
 *
 * One timer serves every subscriber. It is armed for the next local midnight.
 * Timers can be late after sleep, and the time zone can change while the app
 * runs, so the day is also checked when the window regains focus or becomes
 * visible.
 */

const listeners = new Set<() => void>();
let current = localDay();
let timer: ReturnType<typeof setTimeout> | undefined;

function localDay() {
  const now = new Date();
  const { timeZone } = new Intl.DateTimeFormat().resolvedOptions();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${timeZone}`;
}

function check() {
  const next = localDay();
  if (next !== current) {
    current = next;
    for (const listener of listeners) listener();
  }
}

function arm() {
  clearTimeout(timer);
  const now = new Date();
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  timer = setTimeout(() => {
    check();
    arm();
  }, midnight.getTime() - now.getTime());
}

function wake() {
  check();
  arm();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    current = localDay();
    arm();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      timer = undefined;
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    }
  };
}

function snapshot() {
  return current;
}

/** Re-render the caller when the local day (or time zone) changes. */
export function useLocalDay() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
