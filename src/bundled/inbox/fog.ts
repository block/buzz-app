import type { InboxItem } from "../../features/relay/inbox";

/** What a fogged thread's reader has acknowledged: messages from others at or
 * before `at` (seconds), named by ID so same-second arrivals stay distinguishable. */
export type FogRecord = Readonly<{ at: number; ids: readonly string[] }>;
export type FogState = Readonly<Record<string, FogRecord>>;

export const fogKey = "drizzle:inbox-fog";
const MAX_THREADS = 1000;
// Only the newest second's messages are named; Inbox's evidence bound caps them.
const MAX_IDS = 4096;

/** The final thread read step of a qualified row, or undefined for DMs, Solo
 * timeline rows, mentions and anything else Fog does not cover. */
export function fogStep(item: InboxItem) {
  if (!item.thread || item.timeline || item.target.kind === "channel") return;
  const step = item.readThrough[item.readThrough.length - 1];
  return step?.target.kind === "thread" ? step : undefined;
}

/** The stable per-thread key; it survives the row regrouping. */
export function fogId(item: InboxItem) {
  const target = fogStep(item)?.target;
  return target?.kind === "thread"
    ? `${target.channelId}:${target.rootId}`
    : undefined;
}

/** Acknowledge `item`'s messages through `through` (default: all of them). */
export function acknowledge(item: InboxItem, through?: string): FogRecord {
  const limit = through
    ? item.messages.find((message) => message.id === through)?.createdAt
    : undefined;
  const seen = item.messages.filter(
    (message) => limit === undefined || message.createdAt <= limit,
  );
  const at = Math.max(0, limit ?? 0, ...seen.map((m) => m.createdAt));
  const ids = seen.filter((m) => m.createdAt === at).map((m) => m.id);
  return { at, ids };
}

/** Whether others posted anything the record has not acknowledged. Unread
 * state plays no part; the projection already omits the viewer's own messages. */
export const hasCloud = (item: InboxItem, record: FogRecord) =>
  item.messages.some(
    (message) =>
      message.createdAt >= record.at && !record.ids.includes(message.id),
  );

/** Saved fog, tolerating missing, malformed or oversized data. */
export function parseFog(value: unknown): FogState {
  const saved =
    value && typeof value === "object"
      ? (value as { threads?: unknown }).threads
      : undefined;
  if (!saved || typeof saved !== "object") return {};
  const threads: Record<string, FogRecord> = {};
  for (const [id, record] of Object.entries(saved).slice(0, MAX_THREADS)) {
    const { at, ids } = (record ?? {}) as Partial<FogRecord>;
    if (
      typeof at === "number" &&
      Number.isFinite(at) &&
      Array.isArray(ids) &&
      ids.every((entry) => typeof entry === "string")
    )
      threads[id] = { at, ids: ids.slice(-MAX_IDS) };
  }
  return threads;
}

/** `state` with `id` set to `record`, or removed; the oldest entries go first. */
export function withFog(
  state: FogState,
  id: string,
  record: FogRecord | undefined,
): { v: 1; threads: FogState } {
  const { [id]: _, ...rest } = state;
  const entries = Object.entries(record ? { ...rest, [id]: record } : rest);
  return { v: 1, threads: Object.fromEntries(entries.slice(-MAX_THREADS)) };
}
