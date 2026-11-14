import { useCallback, useSyncExternalStore } from "react";

export type ImageLoad = "failed" | "retrying";

// A failed original is shared by every mounted view of the same source, so the
// row and the viewer agree and a Retry from either recovers both. Entries live
// only while a view of their source is mounted: remounting a row still requests
// the original again, as it did before failures were shown.
const loads = new Map<string, ImageLoad>();
const views = new Map<string, Set<() => void>>();

function update(source: string, load: ImageLoad | undefined) {
  if (loads.get(source) === load) return;
  if (load) loads.set(source, load);
  else loads.delete(source);
  for (const notify of views.get(source) ?? []) notify();
}

export function useImageLoad(source: string | undefined) {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!source) return () => {};
      const listeners = views.get(source) ?? new Set();
      views.set(source, listeners);
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
        if (listeners.size) return;
        views.delete(source);
        loads.delete(source);
      };
    },
    [source],
  );
  return useSyncExternalStore(
    subscribe,
    () => (source ? loads.get(source) : undefined),
    // Static markup has no requests, so it never shows a failure.
    () => undefined,
  );
}

export const imageLoaded = (source: string) => update(source, undefined);
export const imageFailed = (source: string) => update(source, "failed");

/** Views render a fresh request while retrying; repeated presses are ignored. */
export function retryImage(source: string) {
  if (loads.get(source) === "failed") update(source, "retrying");
}
