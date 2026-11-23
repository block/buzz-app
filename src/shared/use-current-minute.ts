import { useSyncExternalStore } from "react";

/**
 * The current Unix minute, for labels relative to now ("5 minutes ago").
 * Reading it subscribes the component itself, so a label stays true even when
 * its parent row is memoized and nothing else changes.
 *
 * One timer serves every subscriber, armed for the next minute boundary.
 * Timers can be late after sleep, so the minute is also checked when the window
 * regains focus or becomes visible.
 */

const listeners = new Set<() => void>();
let current = minute();
let timer: ReturnType<typeof setTimeout> | undefined;

function minute() {
  return Math.floor(Date.now() / 60_000);
}

function check() {
  const next = minute();
  if (next !== current) {
    current = next;
    for (const listener of listeners) listener();
  }
}

function arm() {
  clearTimeout(timer);
  timer = setTimeout(
    () => {
      check();
      arm();
    },
    60_000 - (Date.now() % 60_000),
  );
}

function wake() {
  check();
  arm();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    current = minute();
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

/** Re-render the caller when the minute changes; returns it in Unix minutes. */
export function useCurrentMinute() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
