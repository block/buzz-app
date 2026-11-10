import type { VirtualizerHandle } from "virtua";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { ChannelQueries } from "../relay/contracts";

export type RowGeometry = { id: string; key: string };
type Entry = {
  width: number;
  defaultSize: number | undefined;
  // Row id to [hash of its key, measured size].
  sizes: Map<string, readonly [number, number]>;
};
// 53-bit string hash (cyrb53): keys stay small however long rows are. A
// collision costs one re-measure, as an unmeasured row does.
const hash = (text: string) => {
  let a = 0xdeadbeef,
    b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a =
    Math.imul(a ^ (a >>> 16), 2246822507) ^
    Math.imul(b ^ (b >>> 13), 3266489909);
  b =
    Math.imul(b ^ (b >>> 16), 2246822507) ^
    Math.imul(a ^ (a >>> 13), 3266489909);
  return 4294967296 * (2097151 & b) + (a >>> 0);
};
/** Identity/session-scoped and bounded. Each row keeps its own measured size
 * while its key (rendered content and in-place layout context) and the exact
 * layout width are unchanged, so new, edited or reacted rows re-measure alone.
 * Weak ownership releases geometry with the query session. */
const sessions = new WeakMap<ChannelQueries, Map<string, Entry>>();
export function geometryFor(queries: ChannelQueries) {
  const entries = sessions.get(queries) ?? new Map<string, Entry>();
  sessions.set(queries, entries);
  return {
    /** Sizes for rows whose key still matches; -1 leaves a row to the saved estimate. */
    get(
      channelId: string,
      rows: readonly RowGeometry[],
      width: number,
    ): VirtualizerHandle["cache"] | undefined {
      const entry = entries.get(channelId);
      if (entry?.width !== width) return undefined;
      let known = false;
      const sizes = rows.map(({ id, key }) => {
        const cached = entry.sizes.get(id);
        if (cached?.[0] !== hash(key)) return -1;
        known = true;
        return cached[1];
      });
      // With no row known, Virtua estimates from scratch.
      if (!known) return undefined;
      return entry.defaultSize === undefined
        ? [sizes]
        : [sizes, entry.defaultSize];
    },
    set(
      channelId: string,
      rows: readonly RowGeometry[],
      width: number,
      [measured, defaultSize]: VirtualizerHandle["cache"],
    ) {
      const previous = entries.get(channelId);
      entries.delete(channelId);
      // Only loaded rows are kept, which bounds each channel by its window.
      const sizes = new Map<string, readonly [number, number]>();
      rows.forEach(({ id, key }, index) => {
        const size = measured[index] ?? -1;
        const keyHash = hash(key);
        // A row never mounted this time keeps an earlier size for its key.
        const kept =
          previous?.width === width ? previous.sizes.get(id) : undefined;
        if (size >= 0) sizes.set(id, [keyHash, size]);
        else if (kept?.[0] === keyHash) sizes.set(id, kept);
      });
      entries.set(channelId, { width, defaultSize, sizes });
      while (entries.size > 3) {
        const first = entries.keys().next().value;
        if (first === undefined) break;
        entries.delete(first);
      }
    },
  };
}
const eventSignatures = new WeakMap<ChannelMessage, string>();
/** What a row's own rendering depends on: its event, resolved names and profiles. */
export const rowSignature = (
  event: ChannelMessage,
  profiles: ReadonlyMap<string, Profile>,
  resolveName?: (id: string, fallback: string) => string,
) => {
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
};
