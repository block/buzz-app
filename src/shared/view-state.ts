// View intent is durable and explicitly partitioned; connection generations are not storage keys.
const viewListeners = new Map<string, Set<() => void>>();
const composerDraftKey =
  /^draft:([a-zA-Z0-9][a-zA-Z0-9._-]{0,255})(?::thread:([0-9a-f]{64}))?$/;
export function draftCoordinates(key: string) {
  const match = composerDraftKey.exec(key);
  return match?.[1]
    ? { channelId: match[1], ...(match[2] ? { threadRootId: match[2] } : {}) }
    : undefined;
}
const changed = (scope: string) => {
  for (const listener of viewListeners.get(scope) ?? []) listener();
};
/** Same durable view keys as the composer; no parallel draft store or index. */
export function subscribeView(scope: string, listener: () => void) {
  let listeners = viewListeners.get(scope);
  if (!listeners) {
    listeners = new Set();
    viewListeners.set(scope, listeners);
  }
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    try {
      if (event.storageArea !== localStorage) return;
      if (event.key === null) {
        listener();
        return;
      }
      if (!event.key.startsWith("buzz-view.v1:")) return;
      const pair: unknown = JSON.parse(event.key.slice("buzz-view.v1:".length));
      if (Array.isArray(pair) && pair[0] === scope) listener();
    } catch {
      /* Storage may be unavailable while a window is closing. */
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("storage", onStorage);
    listeners?.delete(listener);
    if (!listeners?.size) viewListeners.delete(scope);
  };
}

export function readView<T>(scope: string, key: string, fallback: T): T {
  try {
    return (
      JSON.parse(
        localStorage.getItem(`buzz-view.v1:${JSON.stringify([scope, key])}`) ??
          "null",
      ) ?? fallback
    );
  } catch {
    return fallback;
  }
}
export function writeView(scope: string, key: string, value: unknown) {
  try {
    localStorage.setItem(
      `buzz-view.v1:${JSON.stringify([scope, key])}`,
      JSON.stringify(value),
    );
    changed(scope);
  } catch {
    /* Keep the in-memory editor usable when browser storage is unavailable. */
  }
}

/** Snapshot of a viewer's existing composer drafts, never other view coordinates. */
export function listDraftViews(
  scope: string,
  meaningful: (value: unknown) => boolean,
  selected?: string,
): Readonly<{
  entries: readonly Readonly<{ key: string; value: unknown }>[];
  limited: boolean;
}> {
  const prefix = "buzz-view.v1:";
  const drafts: { key: string; value: unknown }[] = [];
  let limited = false;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (!storageKey?.startsWith(prefix)) continue;
      let pair: unknown;
      try {
        pair = JSON.parse(storageKey.slice(prefix.length));
      } catch {
        continue;
      }
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        pair[0] !== scope ||
        typeof pair[1] !== "string" ||
        !draftCoordinates(pair[1])
      )
        continue;
      const raw = localStorage.getItem(storageKey);
      if (!raw || raw.length > 128 * 1024) continue;
      try {
        const value: unknown = JSON.parse(raw);
        if (!meaningful(value)) continue;
        if (drafts.length === 500) {
          limited = true;
          break;
        }
        drafts.push({ key: pair[1], value });
      } catch {
        /* Malformed old draft. */
      }
    }
  } catch {
    /* Storage unavailable; composer remains usable in memory. */
  }
  // Direct scoped lookup preserves an emptied selected editor even beyond the cap.
  if (
    selected &&
    draftCoordinates(selected) &&
    !drafts.some((entry) => entry.key === selected)
  ) {
    try {
      const raw = localStorage.getItem(
        `${prefix}${JSON.stringify([scope, selected])}`,
      );
      if (raw && raw.length <= 128 * 1024)
        drafts.push({ key: selected, value: JSON.parse(raw) });
    } catch {
      /* Missing/malformed/removed draft retires selection. */
    }
  }
  return { entries: drafts, limited };
}

/** Recovery callers must confirm cleanup before retiring their durable operation. */
export function clearView(scope: string, ...keys: string[]) {
  for (const key of keys) {
    const storageKey = `buzz-view.v1:${JSON.stringify([scope, key])}`;
    localStorage.removeItem(storageKey);
    if (localStorage.getItem(storageKey) !== null)
      throw new Error("Could not clear the saved message. Try again.");
  }
  changed(scope);
}
