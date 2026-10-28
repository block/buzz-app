import type { VirtualizerHandle } from "virtua";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { ChannelQueries } from "../relay/contracts";

type Entry = {
  signature: string;
  width: number;
  cache: VirtualizerHandle["cache"];
};
const SIGNATURE_LIMIT = 256 * 1024;
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
      if (signature.length > SIGNATURE_LIMIT) return;
      entries.set(channelId, { signature, width, cache });
      while (entries.size > 3) {
        const first = entries.keys().next().value;
        if (first === undefined) break;
        entries.delete(first);
      }
    },
  };
}
type Saved = {
  channelId: string;
  /** Hash and length of the signature; the signature itself holds row text. */
  key: string;
  width: number;
  cache: VirtualizerHandle["cache"];
};
const savedKey = (scope: string) => `buzz-geometry.v1:${JSON.stringify(scope)}`;
// 53-bit string hash (cyrb53). A collision can only seed estimates that Virtua
// re-measures when those rows mount.
function signatureKey(signature: string) {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < signature.length; i++) {
    const code = signature.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${signature.length}:${hash.toString(36)}`;
}
const isSize = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= -1;
function readSaved(scope: string): Saved | undefined {
  try {
    const entry: Partial<Saved> | null = JSON.parse(
      localStorage.getItem(savedKey(scope)) ?? "null",
    );
    return typeof entry?.channelId === "string" &&
      typeof entry.key === "string" &&
      typeof entry.width === "number" &&
      Array.isArray(entry.cache) &&
      Array.isArray(entry.cache[0]) &&
      entry.cache[0].every(isSize) &&
      (entry.cache[1] === undefined || isSize(entry.cache[1]))
      ? (entry as Saved)
      : undefined;
  } catch {
    return undefined;
  }
}
/** The measurements of the timeline a viewer left open, kept across launches so
 * the restored timeline mounts the rows it shows rather than estimates. Exact
 * content and layout width still gate reuse. */
export function savedGeometry(scope: string) {
  return {
    get(channelId: string, signature: string, width: number) {
      const entry = readSaved(scope);
      return entry?.channelId === channelId &&
        entry.width === width &&
        signature.length <= SIGNATURE_LIMIT &&
        entry.key === signatureKey(signature)
        ? entry.cache
        : undefined;
    },
    set(
      channelId: string,
      signature: string,
      width: number,
      cache: VirtualizerHandle["cache"],
    ) {
      if (!width || signature.length > SIGNATURE_LIMIT) return;
      const entry: Saved = {
        channelId,
        key: signatureKey(signature),
        width,
        cache,
      };
      try {
        localStorage.setItem(savedKey(scope), JSON.stringify(entry));
      } catch {
        /* Storage may be full or unavailable; measuring still works. */
      }
    },
  };
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
