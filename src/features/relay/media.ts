import { ByteLru } from "./budget";
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
      if (disposed || typeof Image === "undefined") return;
      // New intent replaces queued speculation; active requests remain capped at two.
      for (const url of queue) pending.delete(url);
      queue = [];
      for (const url of [...new Set(urls)].slice(0, 24)) {
        if (images.get(url) || pending.has(url)) continue;
        pending.add(url);
        queue.push(url);
      }
      pump();
    },
    stats: () => ({
      ...images.stats(),
      active: active.size,
      queued: queue.length,
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
