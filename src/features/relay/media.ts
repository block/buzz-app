import { ByteLru } from "./budget";
/** The Save-Data preference (Network Information API) opts out of speculative
 * media traffic. Demand fetches still happen; only warming is disabled. */
export function saveData(): boolean {
  try {
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    return connection?.saveData === true;
  } catch {
    return false;
  }
}

/** Display URLs covered by a recent prepare intent, for warm/cold attribution.
 * Survives session recreation; entries expire. */
const INTENT_TTL_MS = 5 * 60_000;
const intended = new Map<string, number>();
function markIntended(url: string) {
  intended.set(url, Date.now());
  if (intended.size > 512) {
    const oldest = [...intended.keys()][0];
    if (oldest) intended.delete(oldest);
  }
}
export function wasIntended(url: string): boolean {
  const at = intended.get(url);
  if (at === undefined) return false;
  if (Date.now() - at > INTENT_TTL_MS) {
    intended.delete(url);
    return false;
  }
  return true;
}
/** Small decoded-avatar hot set. Never warms originals/attachments that this renderer doesn't display.
 * Natural dimensions account for decoded pixels, not compressed transfer bytes. */
export function createMediaPreparation({
  maxBytes = 16 * 1024 * 1024,
  maxEntries = 64,
} = {}) {
  const images = new ByteLru<HTMLImageElement>(maxEntries, maxBytes);
  const pending = new Set<string>();
  let queue: string[] = [];
  let disposed = false;
  const active = new Set<HTMLImageElement>();
  const cancellations = new Map<HTMLImageElement, () => void>();
  let prefetched = 0;
  function pump() {
    if (disposed || typeof Image === "undefined") return;
    while (active.size < 2 && queue.length) {
      const url = queue.shift();
      if (url === undefined) break;
      const image = new Image();
      active.add(image);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        image.onload = image.onerror = null;
        active.delete(image);
        cancellations.delete(image);
        pending.delete(url);
        pump();
      };
      const timeout = setTimeout(() => {
        image.src = "";
        finish();
      }, 10000);
      cancellations.set(image, finish);
      image.onerror = finish;
      image.onload = () => {
        // Do not explicitly decode enormous originals just to prepare an avatar.
        const bytes = image.naturalWidth * image.naturalHeight * 4;
        if (bytes > maxBytes / 2) {
          finish();
          return;
        }
        void image
          .decode()
          .then(
            () => {
              if (!disposed) images.set(url, image, bytes);
            },
            () => {},
          )
          .finally(finish);
      };
      image.referrerPolicy = "no-referrer";
      image.src = url;
    }
  }
  return {
    prepare(urls: readonly string[]) {
      if (disposed || saveData() || typeof Image === "undefined") return;
      // New intent replaces queued speculation; active requests remain capped at two.
      for (const url of queue) pending.delete(url);
      queue = [];
      for (const url of [...new Set(urls)].slice(0, 24)) {
        markIntended(url);
        if (images.get(url) || pending.has(url)) continue;
        pending.add(url);
        queue.push(url);
      }
      pump();
    },
    /** Prefetch-path warming: appends speculation instead of replacing it, so
     * serial background channel reads accumulate avatars across channels. */
    warm(urls: readonly string[]) {
      if (disposed || saveData() || typeof Image === "undefined") return;
      for (const url of [...new Set(urls)]) {
        markIntended(url);
        if (images.get(url) || pending.has(url) || queue.includes(url))
          continue;
        if (queue.length >= 48) break;
        pending.add(url);
        queue.push(url);
        prefetched++;
      }
      pump();
    },
    stats: () => ({
      ...images.stats(),
      active: active.size,
      queued: queue.length,
      prefetched,
    }),
    dispose() {
      disposed = true;
      queue = [];
      images.clear();
      for (const image of active) {
        image.src = "";
        cancellations.get(image)?.();
      }
      pending.clear();
    },
  };
}
