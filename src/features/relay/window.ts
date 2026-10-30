import { CHANNEL_ROW_KINDS } from "./membership";
import { isObject, objectBody } from "./body";
import { hasTag, type ReadFilter, type RelayEvent } from "./events";

export type WindowCursor = Readonly<{ createdAt: number; eventId: string }>;
export type WindowPage = Readonly<{
  events: RelayEvent[];
  cursor: WindowCursor | null;
  hasMore: boolean;
}>;
export const WINDOW_PAGE_SIZE = 20;
/** Membership notices one notice read returns at most. */
export const NOTICE_LIMIT = 500;

/** NIP-CW window request: top-level rows plus aux closure and thread summaries, paged by the relay's composite cursor.
 * Without `notices`, membership notices are left out and spend none of the page. */
export function windowFilter(
  channelId: string,
  cursor: WindowCursor | null,
  limit = WINDOW_PAGE_SIZE,
  notices = true,
): ReadFilter {
  return {
    kinds: notices
      ? [...CHANNEL_ROW_KINDS]
      : CHANNEL_ROW_KINDS.filter((kind) => kind !== 40099),
    "#h": [channelId],
    limit: Math.max(1, Math.min(200, limit)),
    top_level: true,
    include_aux: true,
    include_summaries: true,
    ...(cursor ? { until: cursor.createdAt, before_id: cursor.eventId } : {}),
  };
}
/** The relay-signed membership notices at or before `cursor`, newest first. */
export function noticeFilter(
  channelId: string,
  relayAuthor: string,
  cursor: WindowCursor | null,
): ReadFilter {
  return {
    kinds: [40099],
    authors: [relayAuthor],
    "#h": [channelId],
    limit: NOTICE_LIMIT,
    ...(cursor ? { until: cursor.createdAt } : {}),
  };
}
/** The relay answers each served window with exactly one signed kind 39006 bounds event. Anything else is rejected;
 * an absent or malformed bound must never be mistaken for "no more history". */
export function parseWindow(
  channelId: string,
  cursor: WindowCursor | null,
  relayAuthor: string,
  events: readonly RelayEvent[],
): WindowPage {
  const suffix = cursor
    ? `${channelId}:${cursor.createdAt}:${cursor.eventId}`
    : `${channelId}:head`;
  const bounds = events.filter(
    (event) =>
      event.kind === 39006 &&
      event.pubkey === relayAuthor &&
      hasTag(event, "h", channelId) &&
      hasTag(event, "d", suffix),
  );
  const [bound] = bounds;
  if (bounds.length !== 1 || !bound)
    throw new Error("Channel history response has invalid window bounds");
  const body = objectBody(bound.content);
  if (!body) throw new Error("Channel history bounds are malformed");
  if (typeof body.has_more !== "boolean")
    throw new Error("Channel history bounds omit has_more");
  const next = body.next_cursor;
  let nextCursor: WindowCursor | null = null;
  if (next != null) {
    if (
      !isObject(next) ||
      typeof next.created_at !== "number" ||
      !Number.isSafeInteger(next.created_at) ||
      next.created_at < 0 ||
      typeof next.id !== "string" ||
      !/^[0-9a-f]{64}$/.test(next.id)
    )
      throw new Error("Channel history cursor is malformed");
    nextCursor = { createdAt: next.created_at, eventId: next.id };
    // History order is descending timestamp, then ascending id. Equal-time
    // pages must move to a lexically greater id; a repeated cursor is not progress.
    if (
      cursor &&
      (nextCursor.createdAt > cursor.createdAt ||
        (nextCursor.createdAt === cursor.createdAt &&
          nextCursor.eventId <= cursor.eventId))
    )
      throw new Error("Channel history cursor does not advance");
  }
  if (body.has_more !== (nextCursor !== null))
    throw new Error("Channel history bounds contradict their cursor");
  return {
    events: events.filter((event) => event.kind !== 39006),
    hasMore: body.has_more,
    cursor: nextCursor,
  };
}
