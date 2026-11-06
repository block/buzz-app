import { useSyncExternalStore } from "react";
import { relativeTimestamp } from "./relative-timestamp";

/**
 * Labels in memoized rows have nothing else to re-render them as time passes.
 * One interval serves every caller while any is mounted, twice a minute because
 * labels count whole minutes; a caller re-renders only when its text changes.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  if (listeners.size === 0)
    timer = setInterval(() => {
      for (const each of listeners) each();
    }, 30_000);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) clearInterval(timer);
  };
}

const unsubscribed = () => () => {};

/** `relativeTimestamp` kept current, such as "5 minutes ago"; undefined without a time. */
export function useRelativeTimestamp(unixSeconds: number | undefined) {
  const read = () =>
    unixSeconds === undefined ? undefined : relativeTimestamp(unixSeconds);
  return useSyncExternalStore(
    unixSeconds === undefined ? unsubscribed : subscribe,
    read,
    read,
  );
}
