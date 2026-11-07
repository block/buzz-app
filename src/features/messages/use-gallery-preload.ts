import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "../relay/contracts";
import { saveData } from "../relay/media";

/** Original requests in flight at once; the visible image loads outside this. */
const WARM_CONCURRENCY = 2;
/** About 96 MB of decoded RGBA (6000×4000). */
const MAX_WARM_PIXELS = 24_000_000;
const MAX_WARM_BYTES = 25_000_000;

/** Hold every gallery thumbnail so a selected image can show its preview at
 * once, behind the visible original. Under Save-Data nothing is held, and only
 * the visible image loads its own preview. Returns the thumbnails whose latest
 * prefetch failed: browsers retry a failed image for each new element, so
 * those images go straight to their fallback frame. */
export function usePrefetchedPreviews(sources: readonly string[]) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const images = useRef(new Map<string, HTMLImageElement>());
  const key = sources.join("\n");
  // Rows streaming into the thread change the list; held requests carry over.
  useEffect(() => {
    const wanted = new Set(saveData() || !key ? [] : key.split("\n"));
    for (const [source, image] of images.current) {
      if (wanted.has(source)) continue;
      abort(image);
      images.current.delete(source);
    }
    for (const source of wanted) {
      if (images.current.has(source)) continue;
      const image = new Image();
      image.fetchPriority = "low";
      // A source removed and added again is fetched again.
      image.onload = () =>
        setFailed((current) => {
          if (!current.has(source)) return current;
          const next = new Set(current);
          next.delete(source);
          return next;
        });
      image.onerror = () =>
        setFailed((current) => new Set(current).add(source));
      image.src = source;
      images.current.set(source, image);
    }
  }, [key]);
  useEffect(() => {
    const held = images.current;
    return () => {
      for (const image of held.values()) abort(image);
      held.clear();
    };
  }, []);
  return failed;
}

/** Large originals are not decoded ahead of a visit. */
export function warmable(attachment: Attachment): boolean {
  const { width = 0, height = 0 } = attachment.dimensions ?? {};
  return (
    width * height <= MAX_WARM_PIXELS &&
    (attachment.size ?? 0) <= MAX_WARM_BYTES
  );
}

type Warmer = { image: HTMLImageElement; settled: boolean };

// Clearing the source fires `error`, which must not count as settling or failing.
function abort(image: HTMLImageElement) {
  image.onload = image.onerror = null;
  image.src = "";
}

function cancel({ image, settled }: Warmer) {
  if (!settled) abort(image);
}

/** Decode the next two originals in the direction of travel and the previous
 * one. Requests that leave that window are cancelled by clearing their source:
 * a released `<img>` keeps downloading in Chromium otherwise. WebKit finishes a
 * cleared load anyway, though nothing holds or paints it.
 *
 * Returns `release`, which navigation calls with the original it is leaving.
 * One that has not loaded is taken over, so it too is cancelled once it leaves
 * the window. A ref cleanup cannot tell: StrictMode detaches and reattaches
 * the refs of a mounted element. */
export function useWarmOriginals(
  sources: readonly (string | undefined)[],
  index: number,
  direction: number,
) {
  const warmers = useRef(new Map<string, Warmer>());
  const pump = useRef<() => void>(undefined);
  const track = useCallback((source: string, image: HTMLImageElement) => {
    const warmer = { image, settled: false };
    const settle = () => {
      if (warmer.settled) return;
      warmer.settled = true;
      pump.current?.();
    };
    image.onload = () => void image.decode().then(settle, settle);
    image.onerror = settle;
    warmers.current.set(source, warmer);
  }, []);
  const key = sources.map((source) => source ?? "").join("\n");
  useEffect(() => {
    const list = key.split("\n");
    const wanted = saveData()
      ? []
      : [index + direction, index + 2 * direction, index - direction].flatMap(
          (at) => list[at] || [],
        );
    const keep = new Set([list[index], ...wanted]);
    for (const [source, warmer] of warmers.current) {
      if (keep.has(source)) continue;
      cancel(warmer);
      warmers.current.delete(source);
    }
    pump.current = () => {
      for (const source of wanted) {
        const loading = [...warmers.current.values()].filter(
          (warmer) => !warmer.settled,
        ).length;
        if (loading >= WARM_CONCURRENCY) return;
        if (warmers.current.has(source)) continue;
        const image = new Image();
        image.fetchPriority = "low";
        track(source, image);
        image.src = source;
      }
    };
    pump.current();
  }, [key, index, direction, track]);
  useEffect(() => {
    const active = warmers.current;
    return () => {
      pump.current = undefined;
      for (const warmer of active.values()) cancel(warmer);
      active.clear();
    };
  }, []);
  // The photo just left is the new window's previous one, so it keeps loading
  // until the selection moves past it.
  return useCallback(
    (image: HTMLImageElement) => {
      const source = image.getAttribute("src");
      if (!source || image.complete) return;
      // A warmer for the same source already holds this request.
      if (warmers.current.has(source)) image.src = "";
      else track(source, image);
    },
    [track],
  );
}
