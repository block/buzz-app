import { useSyncExternalStore } from "react";

// Thread roots the relay answered without (ThreadSnapshot.missing), such as a
// deleted original. A Send to channel copy of one of its replies then offers
// its own thread, since the original's has no composer.
const missing = new Set<string>();
const listeners = new Set<() => void>();
const keyOf = (scope: string, channelId: string, rootId: string) =>
  `${scope}\n${channelId}\n${rootId}`;
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Record whether a thread read found its root. */
export function markThreadRoot(
  scope: string,
  channelId: string,
  rootId: string,
  found: boolean,
) {
  const key = keyOf(scope, channelId, rootId);
  if (missing.has(key) !== found) return;
  if (found) missing.delete(key);
  else missing.add(key);
  for (const notify of [...listeners]) notify();
}

/** Whether a thread read confirmed this root missing. */
export function useMissingThreadRoot(
  scope: string | undefined,
  channelId: string,
  rootId: string | undefined,
) {
  const get = () =>
    scope !== undefined &&
    rootId !== undefined &&
    missing.has(keyOf(scope, channelId, rootId));
  return useSyncExternalStore(subscribe, get, get);
}
