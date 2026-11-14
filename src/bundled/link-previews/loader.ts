import type { Host, HostPagePreview } from "../../features/host/service";
import { previewable } from "./safety";

export type Page = Readonly<{
  url: string;
  title: string;
  description?: string;
  siteName?: string;
  image?: string;
  imageAlt?: string;
}>;

const MAX_REDIRECTS = 5;
const PARALLEL = 4;
const KEEP_PAGES = 200;
const KEEP_FAILURES = 200;
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const KEEP_IMAGES = 60;
const MAX_IMAGE_BYTES = 4_000_000;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

type Reader = Pick<Host, "readPage" | "requestBytes">;
type Pending<T> = {
  promise: Promise<T | null>;
  controller: AbortController;
  users: number;
  started: boolean;
  done: boolean;
};
type PageEntry = Pending<Page> & { value?: Page };
type Held = Pending<string> & { ready?: string | null; kept: boolean };
type Waiter = { start(run: boolean): void; signal: AbortSignal };
export type Lease<T> = Readonly<{ value: Promise<T | null>; release(): void }>;
export type ImageLease = Readonly<{
  src: Promise<string | null>;
  release(): void;
}>;

/** Reads previews and their images through the host, at most `PARALLEL` at
 * once and newest request first, checking every redirect hop with
 * `previewable` before asking again. A request whose last lease is released
 * while it waits never reaches the host; one already under way finishes, so a
 * card that remounts joins it. Pages are kept for the session and
 * failures for a short cooldown. Image `src` values are only ever `blob:`
 * URLs, so the web view never fetches a page-chosen address. */
export function createLoader(host: Reader | undefined, now = Date.now) {
  const readPage = host?.readPage?.bind(host);
  const requestBytes = host?.requestBytes?.bind(host);
  const pages = new Map<string, PageEntry>();
  const failures = new Map<string, number>();
  const images = new Map<string, Held>();
  const waiting: Waiter[] = [];
  let active = 0;
  let stopped = false;

  /** Hands a finished run's place straight to the newest waiter, so `active`
   * counts places rather than runs. */
  async function slot<T>(
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T | null> {
    if (stopped || signal.aborted) return null;
    if (active >= PARALLEL) {
      const started = await new Promise<boolean>((resolve) => {
        const waiter: Waiter = { start: resolve, signal };
        waiting.push(waiter);
        signal.addEventListener(
          "abort",
          () => {
            const at = waiting.indexOf(waiter);
            if (at < 0) return;
            waiting.splice(at, 1);
            resolve(false);
          },
          { once: true },
        );
      });
      if (!started) return null;
    } else active++;
    try {
      return stopped || signal.aborted ? null : await run();
    } finally {
      const next = waiting.pop();
      if (next) next.start(true);
      else active--;
    }
  }

  /** Follows redirects one checked hop at a time; `ask` returns the next
   * location to try, a final value, or null. */
  async function follow<T>(
    start: string,
    entry: Pending<T>,
    ask: (url: URL) => Promise<{ location: string } | { value: T } | null>,
  ): Promise<T | null> {
    let current = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const target = previewable(current);
      if (!target || stopped) return null;
      const reply = await slot(entry.controller.signal, () => {
        entry.started = true;
        return ask(target);
      });
      if (!reply) return null;
      if ("value" in reply) return reply.value;
      try {
        current = new URL(reply.location, target).href;
      } catch {
        return null;
      }
    }
    return null;
  }

  const toPage = (url: string, preview: HostPagePreview): Page | null => {
    const title = preview.title?.trim();
    if (!title) return null;
    const image = preview.image && previewable(preview.image)?.href;
    return {
      url,
      title,
      ...(preview.description ? { description: preview.description } : {}),
      ...(preview.siteName ? { siteName: preview.siteName } : {}),
      ...(image ? { image } : {}),
      ...(preview.imageAlt ? { imageAlt: preview.imageAlt } : {}),
    };
  };

  const failedRecently = (url: string) => {
    const until = failures.get(url);
    if (until === undefined) return false;
    if (until > now()) return true;
    failures.delete(url);
    return false;
  };
  const fail = (url: string) => {
    failures.delete(url);
    failures.set(url, now() + FAILURE_COOLDOWN_MS);
    for (const old of failures.keys()) {
      if (failures.size <= KEEP_FAILURES) break;
      failures.delete(old);
    }
  };
  const touch = <T>(cache: Map<string, T>, key: string, value: T) => {
    cache.delete(key);
    cache.set(key, value);
  };

  const loadPage = (url: string, entry: Pending<Page>) =>
    follow(url, entry, async (target) => {
      if (!readPage) return null;
      const reply = await readPage(target.href, { timeoutMs: 10_000 });
      if (reply.status >= 300 && reply.status < 400)
        return reply.location ? { location: reply.location } : null;
      return reply.preview
        ? { value: toPage(target.href, reply.preview) }
        : null;
    }).catch(() => null);

  const revoke = (held: Held) =>
    void held.promise.then((src) => src && URL.revokeObjectURL(src));
  const revokeIfUnused = (held: Held) => {
    if (!held.kept && held.users === 0) revoke(held);
  };

  const loadImage = (url: string, entry: Pending<string>) =>
    follow(url, entry, async (target) => {
      if (!requestBytes) return null;
      const reply = await requestBytes({
        url: target.href,
        maxBytes: MAX_IMAGE_BYTES,
        timeoutMs: 8000,
      });
      const header = (name: string) =>
        Object.entries(reply.headers).find(
          ([key]) => key.toLowerCase() === name,
        )?.[1];
      if (reply.status >= 300 && reply.status < 400) {
        const location = header("location");
        return location ? { location } : null;
      }
      const type = (header("content-type") ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (
        reply.status !== 200 ||
        !reply.body.byteLength ||
        !type ||
        !IMAGE_TYPES.has(type) ||
        stopped
      )
        return null;
      return {
        value: URL.createObjectURL(
          new Blob([reply.body as BlobPart], { type }),
        ),
      };
    }).catch(() => null);

  const none = { value: Promise.resolve(null), release() {} };

  return {
    available: !!readPage,
    /** What this session already knows of the page: the page, null after a
     * recent failure, or undefined while it is unknown or still loading. */
    peek(url: string): Page | null | undefined {
      const value = pages.get(url)?.value;
      if (value) return value;
      return failedRecently(url) ? null : undefined;
    },
    /** The image's `blob:` URL when it has already loaded. */
    peekImage(url: string): string | null | undefined {
      return images.get(url)?.ready;
    },
    /** A lease on the page's preview. Releasing the last lease before the
     * read finishes withdraws it. */
    page(url: string): Lease<Page> {
      if (!readPage || stopped || failedRecently(url)) return none;
      let entry = pages.get(url);
      if (entry) touch(pages, url, entry);
      else {
        const controller = new AbortController();
        const created: PageEntry = {
          promise: Promise.resolve(null),
          controller,
          users: 0,
          started: false,
          done: false,
        };
        created.promise = loadPage(url, created);
        entry = created;
        pages.set(url, created);
        void created.promise.then((value) => {
          created.done = true;
          if (pages.get(url) !== created) return;
          if (controller.signal.aborted) pages.delete(url);
          else if (!value) {
            pages.delete(url);
            if (!stopped) fail(url);
          } else {
            created.value = value;
            for (const [key, old] of pages) {
              if (pages.size <= KEEP_PAGES) break;
              if (old.done) pages.delete(key);
            }
          }
        });
      }
      const leased = entry;
      leased.users++;
      let released = false;
      return {
        value: leased.promise,
        release() {
          if (released) return;
          released = true;
          leased.users--;
          if (leased.users > 0 || leased.started) return;
          leased.controller.abort();
          if (pages.get(url) === leased) pages.delete(url);
        },
      };
    },
    /** A lease on the image's `blob:` URL. The cache keeps at most
     * `KEEP_IMAGES` for reuse, but a URL is revoked only once it has left the
     * cache and every lease on it is released. */
    image(url: string): ImageLease {
      if (!requestBytes || stopped)
        return { src: Promise.resolve(null), release() {} };
      let held = images.get(url);
      if (held) touch(images, url, held);
      else {
        const entry: Held = {
          promise: Promise.resolve(null),
          controller: new AbortController(),
          users: 0,
          started: false,
          done: false,
          kept: true,
        };
        entry.promise = loadImage(url, entry);
        held = entry;
        images.set(url, entry);
        void entry.promise.then((src) => {
          entry.done = true;
          entry.ready = src;
          if (src === null && images.get(url) === entry) {
            images.delete(url);
            entry.kept = false;
          }
        });
        for (const [old, value] of images) {
          if (images.size <= KEEP_IMAGES) break;
          images.delete(old);
          value.kept = false;
          revokeIfUnused(value);
        }
      }
      const leased = held;
      leased.users++;
      let released = false;
      return {
        src: leased.promise,
        release() {
          if (released) return;
          released = true;
          leased.users--;
          if (leased.users === 0 && !leased.started) {
            leased.controller.abort();
            leased.kept = false;
            if (images.get(url) === leased) images.delete(url);
          }
          revokeIfUnused(leased);
        },
      };
    },
    stop() {
      stopped = true;
      for (const held of images.values()) {
        held.kept = false;
        revoke(held);
      }
      images.clear();
      pages.clear();
      failures.clear();
      for (const waiter of waiting.splice(0)) waiter.start(false);
    },
  };
}
export type Loader = ReturnType<typeof createLoader>;
