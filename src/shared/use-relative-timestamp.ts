import { useSyncExternalStore } from "react";
import { relativeTimestamp } from "./relative-timestamp";

/**
 * Labels in memoized rows have nothing else to re-render them as time passes.
 * One interval serves every caller while any is mounted, twice a minute because
 * labels count whole minutes. Mounted callers format its clock sample, so their
 * snapshot changes only when it ticks, and each re-renders only when its text does.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = 0;

function tick() {
  now = Date.now() / 1000;
  for (const each of listeners) each();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    tick();
    timer = setInterval(tick, 30_000);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) clearInterval(timer);
  };
}

const unsubscribed = () => () => {};

/** `relativeTimestamp` kept current, such as "5 minutes ago"; undefined without a time. */
export function useRelativeTimestamp(unixSeconds: number | undefined) {
  // Until a caller subscribes there is no sample, so use this render's time.
  const rendered = Date.now() / 1000;
  const read = () =>
    unixSeconds === undefined
      ? undefined
      : relativeTimestamp(unixSeconds, listeners.size ? now : rendered);
  return useSyncExternalStore(
    unixSeconds === undefined ? unsubscribed : subscribe,
    read,
    read,
  );
}
