import { type Index, loadIndex } from "./catalog";

/** How long a read index is reused before it is read again. */
const TTL_MS = 5 * 60_000;

export type IndexSource = Readonly<{
  /** The index, read again when `fresh` or when the last read is old. */
  read(fresh?: boolean): Promise<Index>;
  /** Manifest ids of the plugins the latest index lists. */
  listed(): Promise<ReadonlySet<string>>;
}>;

/** One index read shared by the page and the recorder, so a listing the
 * page shows as gone is gone for recording too. A failed read isn't kept. */
export function indexSource(
  host: Parameters<typeof loadIndex>[0],
  url: string,
  ttlMs = TTL_MS,
): IndexSource {
  let cached: { at: number; index: Promise<Index> } | undefined;
  const read = (fresh = false) => {
    if (fresh || !cached || Date.now() - cached.at > ttlMs) {
      const entry = { at: Date.now(), index: loadIndex(host, url) };
      cached = entry;
      entry.index.catch(() => {
        if (cached === entry) cached = undefined;
      });
    }
    return cached.index;
  };
  return {
    read,
    listed: () =>
      read().then((index) => new Set(index.plugins.map((plugin) => plugin.id))),
  };
}
