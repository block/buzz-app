import catalog from "./noto-animated.json";

type Asset = { code: string; duration: number; name: string };
export const notoAssets: Readonly<Record<string, Asset>> = catalog;
export function notoAsset(text: string) {
  // An explicit text-style selector must remain text, and tones/ZWJ sequences
  // must match in full. Only the optional emoji-style selector is normalized.
  if (text.includes("\ufe0e")) return undefined;
  return notoAssets[text] ?? aliases.get(text.replaceAll("\ufe0f", ""));
}
const aliases = new Map(
  Object.entries(notoAssets).map(([text, asset]) => [
    text.replaceAll("\ufe0f", ""),
    asset,
  ]),
);
const active = new WeakMap<HTMLImageElement, () => void>();
const cache = new Map<string, Promise<Blob>>();
export function stopNoto(image: HTMLImageElement) {
  active.get(image)?.();
}

/** Each playback gets its own URL so separate copies never share a frame clock. */
export function playNoto(
  image: HTMLImageElement,
  text: string,
  onStart?: (duration: number) => void,
) {
  const asset = notoAsset(text);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!asset || reduced.matches || active.has(image)) return;
  const still = image.src;
  let cancelled = false;
  let url: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (cancelled) return;
    cancelled = true;
    if (timer) clearTimeout(timer);
    image.removeEventListener("load", loaded);
    image.removeEventListener("error", stop);
    reduced.removeEventListener("change", stop);
    image.src = still;
    if (url) URL.revokeObjectURL(url);
    active.delete(image);
  };
  const loaded = () => {
    if (!cancelled) {
      timer = setTimeout(stop, asset.duration);
      onStart?.(asset.duration);
    }
  };
  active.set(image, stop);
  reduced.addEventListener("change", stop);
  let resource = cache.get(asset.code);
  if (!resource) {
    resource = fetch(`/emoji/noto-animated/${asset.code}.webp`).then(
      (response) => {
        if (!response.ok) throw new Error("Animation unavailable");
        return response.blob();
      },
    );
    cache.set(asset.code, resource);
    const oldest = cache.keys().next().value;
    if (cache.size > 24 && oldest) cache.delete(oldest);
  }
  void resource
    .then((blob) => {
      if (cancelled) return;
      if (!image.isConnected) {
        stop();
        return;
      }
      url = URL.createObjectURL(blob);
      image.addEventListener("load", loaded, { once: true });
      image.addEventListener("error", stop, { once: true });
      image.src = url;
    })
    .catch(() => {
      cache.delete(asset.code);
      stop();
    });
}
