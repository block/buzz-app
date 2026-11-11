import { useSyncExternalStore } from "react";

import { normalizeShortcode } from "../../features/relay/emoji";

/**
 * Per-device favorites for the community custom emoji palette, keyed by
 * community scope. Favorites are a personal preference, not relay state: they
 * live in localStorage the same way emoji-mart keeps its own frequently-used
 * row, and like Mart, everything here works without storage access.
 *
 * Shortcodes are stored raw per scope but validated on read, so a favorite of a
 * shortcode that later leaves the palette is skipped by consumers (the picker)
 * yet kept here, ready to resurface if the palette gains it back.
 */

const STORAGE_KEY = "buzz.emoji.favorites";

const EMPTY: readonly string[] = Object.freeze([]);

type FavoriteIndex = Readonly<Record<string, readonly string[]>>;

const listeners = new Set<() => void>();
let index: FavoriteIndex | undefined;
let snapshots = new Map<string, readonly string[]>();
let cachedRead: { raw: string | null } | { unreadable: true } | undefined;

function parse(raw: string): FavoriteIndex {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const clean: Record<string, readonly string[]> = {};
    for (const [scope, values] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!scope || !Array.isArray(values)) continue;
      const codes = new Set<string>();
      for (const value of values) {
        const code = normalizeShortcode(String(value));
        if (code) codes.add(code);
      }
      if (codes.size) clean[scope] = [...codes];
    }
    return clean;
  } catch {
    return {};
  }
}

function readStorage(): { raw: string | null } | { unreadable: true } {
  try {
    return { raw: localStorage.getItem(STORAGE_KEY) };
  } catch {
    return { unreadable: true };
  }
}

function sameRead(
  a: { raw: string | null } | { unreadable: true },
  b: { raw: string | null } | { unreadable: true },
): boolean {
  if ("unreadable" in a || "unreadable" in b)
    return "unreadable" in a && "unreadable" in b;
  return a.raw === b.raw;
}

/** Read storage on each cache miss; the raw string is the cache token, so a
 * key removed or rewritten underneath us (tests, other tabs) rereads fresh. */
function load(): FavoriteIndex {
  const read = readStorage();
  if (cachedRead && sameRead(cachedRead, read) && index) return index;
  cachedRead = read;
  index = "unreadable" in read || !read.raw ? {} : parse(read.raw);
  snapshots = new Map();
  return index;
}

function snapshotFor(scope: string): readonly string[] {
  // load() first: its storage token check invalidates per-scope snapshots when
  // the document changed underneath us, which is what makes the cache safe.
  load();
  const cached = snapshots.get(scope);
  if (cached) return cached;
  const fresh = index?.[scope] ?? EMPTY;
  snapshots.set(scope, fresh);
  return fresh;
}

/**
 * Add `shortcode` to the scope's favorites, or remove it when already present.
 * A storage write failure leaves memory consistent but unpublished, like Mart.
 */
export function toggleFavoriteEmoji(scope: string, shortcode: string): void {
  const code = normalizeShortcode(shortcode);
  if (!code || !scope) return;
  const current = load();
  const codes = new Set(current[scope] ?? []);
  if (!codes.delete(code)) codes.add(code);
  const next: Record<string, readonly string[]> = { ...current };
  if (codes.size) next[scope] = [...codes];
  else delete next[scope];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    cachedRead = { raw: JSON.stringify(next) };
  } catch {
    /* Like Mart, selection works without localStorage; memory stays consistent. */
  }
  index = next;
  snapshots = new Map();
  for (const listener of listeners) listener();
}

export function subscribeFavorites(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The scope's favorite shortcodes, in the order they were favorited. */
export function useFavoriteEmoji(scope: string): readonly string[] {
  return useSyncExternalStore(subscribeFavorites, () => snapshotFor(scope));
}
