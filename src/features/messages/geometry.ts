import type { VirtualizerHandle } from "virtua";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { ChannelQueries } from "../relay/contracts";
import { readView, writeView } from "../../shared/view-state";

type Entry = {
  signature: string;
  width: number;
  cache: VirtualizerHandle["cache"];
};
/** Identity/session-scoped and bounded. Event content (not IDs alone) and exact layout width
 * invalidate measurements. Weak ownership releases geometry with the query session. */
const sessions = new WeakMap<ChannelQueries, Map<string, Entry>>();
export function geometryFor(queries: ChannelQueries) {
  const entries = sessions.get(queries) ?? new Map<string, Entry>();
  sessions.set(queries, entries);
  return {
    get(channelId: string, signature: string, width: number) {
      const entry = entries.get(channelId);
      return entry?.signature === signature && entry.width === width
        ? entry.cache
        : undefined;
    },
    set(
      channelId: string,
      signature: string,
      width: number,
      cache: VirtualizerHandle["cache"],
    ) {
      entries.delete(channelId);
      // Signatures include rendered text; bound that memory too, not only view count.
      if (signature.length > 256 * 1024) return;
      entries.set(channelId, { signature, width, cache });
      while (entries.size > 3) {
        const first = entries.keys().next().value;
        if (first === undefined) break;
        entries.delete(first);
      }
    },
  };
}
/** 53-bit string hash (cyrb53). */
function hash(text: string) {
  let a = 0xdeadbeef,
    b = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 2654435761);
    b = Math.imul(b ^ code, 1597334677);
  }
  a =
    Math.imul(a ^ (a >>> 16), 2246822507) ^
    Math.imul(b ^ (b >>> 13), 3266489909);
  b =
    Math.imul(b ^ (b >>> 16), 2246822507) ^
    Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}
type Saved = {
  signature: string;
  /** Scroller width, text scale and pixel ratio the sizes were measured at. */
  layout: string;
  cache: VirtualizerHandle["cache"];
};
const SAVED_GEOMETRY = "timeline-geometry";
const SAVED_CHANNELS = 16;
const saved = new Map<string, Map<string, Saved | (() => Saved | undefined)>>();
const live = new Set<() => void>();
const unsaved = new Set<string>();
const savedIn = (scope: string) => {
  let channels = saved.get(scope);
  if (!channels) {
    const stored = readView<unknown>(scope, SAVED_GEOMETRY, null);
    channels = new Map(
      stored && typeof stored === "object"
        ? Object.entries(stored as Record<string, Saved>)
        : [],
    );
    saved.set(scope, channels);
  }
  return channels;
};
const read = (entry: Saved | (() => Saved | undefined) | undefined) =>
  typeof entry === "function" ? entry() : entry;
function persist() {
  for (const record of live) record();
  for (const scope of unsaved) {
    const entries: Record<string, Saved> = {};
    for (const [channelId, entry] of savedIn(scope)) {
      const value = read(entry);
      if (value) entries[channelId] = value;
    }
    writeView(scope, SAVED_GEOMETRY, entries);
  }
  unsaved.clear();
}
/**
 * The same geometry, persisted with the scope's view state when the page
 * hides, as the sidebar's is, so a relaunch that shows the same rows at the
 * same layout restores their measured sizes instead of estimating them.
 */
export const savedGeometry = {
  get(scope: string, channelId: string, signature: string, layout: string) {
    const entry = read(savedIn(scope).get(channelId));
    const cache: unknown = entry?.cache;
    // Storage is untrusted: restore only a well-formed size cache.
    return entry?.layout === layout &&
      Array.isArray(cache) &&
      Array.isArray(cache[0]) &&
      cache[0].every(
        (size) => size === -1 || (Number.isFinite(size) && size >= 0),
      ) &&
      (cache[1] === undefined || (Number.isFinite(cache[1]) && cache[1] > 0)) &&
      entry.signature === hash(signature)
      ? entry.cache
      : undefined;
  },
  /** The signature is hashed only when the geometry is saved or read. */
  set(
    scope: string,
    channelId: string,
    signature: string,
    layout: string,
    cache: VirtualizerHandle["cache"],
  ) {
    const channels = savedIn(scope);
    channels.delete(channelId);
    if (signature.length > 256 * 1024) return;
    let entry: Saved | undefined;
    channels.set(channelId, () => {
      entry ??= { signature: hash(signature), layout, cache };
      return entry;
    });
    while (channels.size > SAVED_CHANNELS) {
      const first = channels.keys().next().value;
      if (first === undefined) break;
      channels.delete(first);
    }
    unsaved.add(scope);
    listen();
  },
  /** A mounted timeline records itself when the page hides. */
  live(record: () => void) {
    live.add(record);
    listen();
    return () => void live.delete(record);
  },
};
let listening = false;
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("pagehide", persist);
}
const eventSignatures = new WeakMap<ChannelMessage, string>();
export const geometrySignature = (
  events: readonly ChannelMessage[],
  profiles: ReadonlyMap<string, Profile>,
  resolveName?: (id: string, fallback: string) => string,
) =>
  events
    .map((event) => {
      let signature = eventSignatures.get(event);
      if (!signature) {
        signature = JSON.stringify(event);
        eventSignatures.set(event, signature);
      }
      const ids = event.membership
        ? [event.membership.actor, event.membership.target]
        : [
            event.authorId,
            ...(event.workflowOwnerId ? [event.workflowOwnerId] : []),
            ...event.mentions,
            ...(event.mentionReferences ?? []),
          ];
      const names = resolveName
        ? ids.map((id) => resolveName(id, profiles.get(id)?.name ?? id))
        : event.workflowOwnerId
          ? [profiles.get(event.workflowOwnerId)?.name]
          : [];
      return `${JSON.stringify(names)}:${signature.length}:${signature}:${JSON.stringify(event.membership ? [profiles.get(event.membership.actor), profiles.get(event.membership.target)] : profiles.get(event.authorId))}`;
    })
    .join("");
