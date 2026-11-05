import { useCallback, useSyncExternalStore } from "react";

/** Agent messages a reader collapsed on this device: event id → when they
 * collapsed it (Unix ms), oldest first. The times let a later cross-device
 * sync merge two devices' choices. */
type Collapsed = ReadonlyMap<string, number>;

/** Oldest-collapsed entries leave first. */
export const COLLAPSED_MESSAGE_LIMIT = 1000;
const key = (scope: string) => `buzz.collapsed-messages.v1:${scope}`;
const none: Collapsed = new Map();
// Parsed once per partition; another window's write or a purge drops it.
const cache = new Map<string, Collapsed>();
const listeners = new Set<() => void>();

function read(scope: string): Collapsed {
  const cached = cache.get(scope);
  if (cached) return cached;
  let saved: Collapsed = none;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(scope)) ?? "[]");
    if (Array.isArray(value))
      saved = new Map(
        value
          .filter(
            (entry): entry is [string, number] =>
              Array.isArray(entry) &&
              typeof entry[0] === "string" &&
              Number.isFinite(entry[1]),
          )
          .sort((a, b) => a[1] - b[1])
          .slice(-COLLAPSED_MESSAGE_LIMIT),
      );
  } catch {
    // Unreadable choices show every message expanded.
  }
  cache.set(scope, saved);
  return saved;
}

function changed() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (!listeners.size && typeof window !== "undefined")
    window.addEventListener("storage", storage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== "undefined")
      window.removeEventListener("storage", storage);
  };
}

function storage(event: StorageEvent) {
  if (event.key !== null && !event.key.startsWith(key(""))) return;
  cache.clear();
  changed();
}

/** Collapses or expands one message. Throws when the choice was not saved,
 * leaving the shown state unchanged. */
export function setMessageCollapsed(
  scope: string,
  id: string,
  collapsed: boolean,
  now = Date.now(),
) {
  const next = new Map(read(scope));
  next.delete(id);
  if (collapsed) next.set(id, now);
  for (const oldest of next.keys()) {
    if (next.size <= COLLAPSED_MESSAGE_LIMIT) break;
    next.delete(oldest);
  }
  localStorage.setItem(key(scope), JSON.stringify([...next]));
  cache.set(scope, next);
  changed();
}

/** Forgets one community's collapsed messages once the viewer has left it. */
export function forgetCollapsedMessages(scope: string) {
  cache.delete(scope);
  localStorage.removeItem(key(scope));
  changed();
}

/** Whether the reader collapsed this message here; false without a scope. */
export function useMessageCollapsed(scope: string | undefined, id: string) {
  const snapshot = useCallback(
    () => !!scope && read(scope).has(id),
    [scope, id],
  );
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
