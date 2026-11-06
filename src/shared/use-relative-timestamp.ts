import { useSyncExternalStore } from "react";
import { relativeTimestamp } from "./relative-timestamp";

/**
 * Labels in memoized rows have nothing else to re-render them as time passes.
 * One interval serves every caller while any is mounted, twice a minute because
 * labels count whole minutes; a caller re-renders only when its text changes.
 * Labels read the interval's clock sample, not the live clock, so a snapshot
 * changes only when the interval notifies.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = 0;

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    now = Date.now() / 1000;
    timer = setInterval(() => {
      now = Date.now() / 1000;
      for (const each of listeners) each();
    }, 30_000);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    clearInterval(timer);
    timer = undefined;
  };
}

const unsubscribed = () => () => {};

/** `relativeTimestamp` kept current, such as "5 minutes ago"; undefined without a time. */
export function useRelativeTimestamp(unixSeconds: number | undefined) {
  // Until a label subscribes there is no sample, so use this render's time.
  const rendered = Date.now() / 1000;
  const read = () =>
    unixSeconds === undefined
      ? undefined
      : relativeTimestamp(unixSeconds, timer === undefined ? rendered : now);
  return useSyncExternalStore(
    unixSeconds === undefined ? unsubscribed : subscribe,
    read,
    read,
  );
}
