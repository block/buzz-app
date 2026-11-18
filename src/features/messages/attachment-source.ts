import { isTauri } from "@tauri-apps/api/core";

/** Only the URLs emitted by convertFileSrc(relayMediaUrl, "buzz-media"). */
export function isNativeMediaSource(source: string): boolean {
  try {
    const url = new URL(source);
    if (
      !(
        (url.protocol === "buzz-media:" && url.hostname === "localhost") ||
        (url.protocol === "http:" && url.hostname === "buzz-media.localhost")
      ) ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    const encoded = url.pathname.slice(1);
    const target = decodeURIComponent(encoded);
    if (!encoded || encodeURIComponent(target) !== encoded) return false;
    const media = new URL(target);
    if (media.href !== target) return false;
    return (
      media.protocol === "https:" &&
      !media.username &&
      !media.password &&
      !media.search &&
      !media.hash &&
      /^\/media\/[0-9a-f]{64}(?:\.(?:[a-z0-9]{1,8}|thumb\.(?:jpg|webp)))?$/.test(
        media.pathname,
      )
    );
  } catch {
    return false;
  }
}

export function isProxySource(source: string): boolean {
  try {
    const hasWindow = typeof window !== "undefined";
    const url = new URL(
      source,
      hasWindow ? window.location.href : "https://app.test",
    );
    const sameOrigin =
      source.startsWith("/") ||
      (hasWindow && url.origin === window.location.origin);
    return (
      sameOrigin &&
      url.pathname.startsWith("/api/relay") &&
      url.pathname.endsWith("/media")
    );
  } catch {
    return false;
  }
}

export function safeOpenUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Artwork the app itself serves, on the page's own origin and outside the
 * relay proxies: the bundled pack avatars, and any other asset the app ships.
 * Only in the desktop app — a browser's image menu can fetch its page's own
 * assets — because WebKit's menu fetches such a URL in its network process,
 * which cannot load the app's private origin, so its image actions do
 * nothing there. The app serves them instead. */
export function isAppArtworkSource(source: string): boolean {
  if (!isTauri()) return false;
  try {
    const url = new URL(source, window.location.href);
    return url.origin === window.location.origin && !isProxySource(url.href);
  } catch {
    return false;
  }
}
