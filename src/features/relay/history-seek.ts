import { isReadBudgetError } from "./errors";
import { WINDOW_KINDS, type WindowCursor, type WindowPage } from "./window";

/** Rows per seek read: the relay's window maximum. */
export const SEEK_PAGE = 200;
/** Relay reads one seek may spend before it gives up. */
export const SEEK_READS = 40;
const DAY = 86_400;

export class SeekLimitError extends Error {
  constructor() {
    super("History seek exceeded its read budget");
    this.name = "SeekLimitError";
  }
}

/** Rows strictly older than `seconds`: past every id in that second. */
export function ceilingCursor(seconds: number): WindowCursor {
  return { createdAt: seconds, eventId: "f".repeat(64) };
}

/** One window page below `cursor` (null: the head). `full` adds aux and summaries. */
export type SeekRead = (
  cursor: WindowCursor | null,
  full: boolean,
  limit?: number,
) => Promise<WindowPage>;

export type Located =
  | Readonly<{ kind: "newest" }>
  /** `page` covers the next portion at or after `from`, plus older context.
   * `ceilingId` includes that boundary row within a partially covered second.
   * A null ceiling means `page` is the head page. */
  | Readonly<{
      kind: "segment";
      page: WindowPage;
      ceiling: number | null;
      ceilingId?: string;
    }>;

/** A page read below a ceiling, against the rows at or after `from`:
 * none (empty), all of them (fits), or too many for one page (overflow). */
function classify(page: WindowPage, from: number) {
  const rows = page.events.filter((event) => WINDOW_KINDS.includes(event.kind));
  if (!rows.some((row) => row.created_at >= from)) return "empty";
  return rows.some((row) => row.created_at < from) || !page.hasMore
    ? "fits"
    : "overflow";
}

/**
 * Find a ceiling whose newest-first page reaches back past `from`, so that it
 * holds the first top-level row at or after `from`. Windows read only newest
 * first, so this probes ceilings: galloping a day at a time from `from`, or
 * from the head when `gallop` is false (the channel start), then bisecting
 * between the last empty and the first overflowing ceiling. Probes are bare;
 * the chosen ceiling is read once in full.
 */
export async function locate(
  read: SeekRead,
  from: number,
  now: number,
  gallop: boolean,
  fromId?: string,
): Promise<Located> {
  let reads = 0;
  let limit = SEEK_PAGE;
  let newest = Math.max(now, from);
  const get = async (cursor: WindowCursor | null, full: boolean) => {
    for (;;) {
      if (++reads > SEEK_READS) throw new SeekLimitError();
      try {
        const page = await read(cursor, full, limit);
        for (const event of page.events)
          if (WINDOW_KINDS.includes(event.kind))
            newest = Math.max(newest, event.created_at);
        return page;
      } catch (error) {
        if (!isReadBudgetError(error) || limit === 1) throw error;
        limit = Math.max(1, Math.floor(limit / 2));
      }
    }
  };
  // No row is in [from, lo). `hi` overflows; null is the head.
  let lo = from;
  let hi: number | null = null;
  let found: number | null | undefined;
  for (let span = DAY; found === undefined; span *= 2) {
    const ceiling = gallop && from + span < now ? from + span : null;
    const probe = await get(
      ceiling === null ? null : ceilingCursor(ceiling),
      false,
    );
    const outcome = classify(probe, from);
    if (outcome === "fits") found = ceiling;
    else if (outcome === "overflow") {
      // A probe whose newest row is already in the boundary second needs
      // keyset traversal, not timestamp bisection through an empty span.
      hi =
        probe.events.find((event) => WINDOW_KINDS.includes(event.kind))
          ?.created_at === from
          ? from + 1
          : ceiling;
      break;
    } else if (ceiling === null) return { kind: "newest" };
    else lo = ceiling;
  }
  for (;;) {
    while (found === undefined) {
      const top = hi ?? newest + 1;
      // More than a page of rows share one second.
      if (top - lo <= 1) {
        if (!fromId) throw new SeekLimitError();
        // Bisect IDs within the dense second. Only adjacent pages may be
        // combined: a probe that skips IDs starts a new retained segment.
        const second = top - 1;
        const target = second === from ? fromId : "f".repeat(64);
        let cursor = ceilingCursor(top);
        let previous: WindowPage | undefined;
        let upperId = BigInt(`0x${target}`);
        for (;;) {
          const page = await get(cursor, true);
          const rows = page.events.filter((event) =>
            WINDOW_KINDS.includes(event.kind),
          );
          const reached = rows.some(
            (event) =>
              event.created_at < from ||
              (event.created_at === from && event.id >= fromId),
          );
          const adjacent =
            previous?.cursor?.createdAt === cursor.createdAt &&
            previous?.cursor?.eventId === cursor.eventId;
          const newer = rows.some(
            (event) => event.created_at === second && event.id < target,
          );
          if ((!previous || adjacent || newer) && (reached || !page.cursor)) {
            const events = [
              ...(adjacent ? (previous?.events ?? []) : []),
              ...page.events,
            ];
            const upper = events.find((event) =>
              WINDOW_KINDS.includes(event.kind),
            );
            return {
              kind: "segment",
              ceiling: previous ? (upper?.created_at ?? top) : top,
              ...(previous && upper ? { ceilingId: upper.id } : {}),
              page: { ...page, events },
            };
          }
          // A probe may land in the ID gap immediately before the target.
          // Read after the last newer page to recover its adjacent context.
          if (reached || !page.cursor) {
            upperId = BigInt(`0x${cursor.eventId}`);
            if (!previous?.cursor) throw new SeekLimitError();
            cursor = previous.cursor;
            continue;
          }
          previous = page;
          const lower = page.cursor;
          if (!lower) throw new SeekLimitError();
          const lowerId = BigInt(`0x${lower.eventId}`);
          const mid = (lowerId + upperId) / 2n;
          cursor = {
            createdAt: second,
            eventId: mid.toString(16).padStart(64, "0"),
          };
        }
      }
      const mid = Math.floor((lo + top) / 2);
      const outcome = classify(await get(ceilingCursor(mid), false), from);
      if (outcome === "fits") found = mid;
      else if (outcome === "empty") lo = mid;
      else hi = mid;
    }
    const page = await get(found === null ? null : ceilingCursor(found), true);
    if (classify(page, from) === "overflow") {
      // Full reads include auxiliary data, so a smaller admitted page may no
      // longer reach the boundary established by its bare probe.
      hi = found;
      found = undefined;
      continue;
    }
    return { kind: "segment", page, ceiling: found };
  }
}
