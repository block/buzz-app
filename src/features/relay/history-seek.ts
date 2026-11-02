import {
  olderThan,
  WINDOW_KINDS,
  type WindowCursor,
  type WindowPage,
} from "./window";

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

/** Rows strictly older than `seconds`: past every id in that second. As a
 * seek's `from`, every row at or after `seconds`. */
export function ceilingCursor(seconds: number): WindowCursor {
  return { createdAt: seconds, eventId: "f".repeat(64) };
}

/** One window page below `cursor` (null: the head). `full` adds aux and summaries. */
export type SeekRead = (
  cursor: WindowCursor | null,
  full: boolean,
) => Promise<WindowPage>;

export type Located =
  | Readonly<{ kind: "newest" }>
  /** `page` holds every row from `from` up to, not including, `ceiling`,
   * and older context below it. A null ceiling means `page` is the head page. */
  | Readonly<{
      kind: "segment";
      page: WindowPage;
      ceiling: WindowCursor | null;
    }>;

/** A page read below a ceiling, against the rows at or after `from`:
 * none (empty), all of them (fits), or too many for one page (overflow). */
function classify(page: WindowPage, from: WindowCursor) {
  const rows = page.events.filter((event) => WINDOW_KINDS.includes(event.kind));
  if (rows.every((row) => olderThan(row, from))) return "empty";
  return rows.some((row) => olderThan(row, from)) || !page.hasMore
    ? "fits"
    : "overflow";
}

/**
 * Find a ceiling whose newest-first page reaches back past `from`, so that it
 * holds the first top-level row at or after `from`. Windows read only newest
 * first, so this probes ceilings: galloping a day at a time from `from`, or
 * from the head when `gallop` is false (the channel start), then bisecting
 * between the last empty and the first overflowing ceiling. A second with
 * more than a page of rows is then walked page by page, by the relay's
 * cursor. Probes are bare; the chosen ceiling is read once in full.
 *
 * `from` is a window key: rows not older than it are the ones sought
 * (`ceilingCursor(t)` for a time, a segment's ceiling for the rows above it).
 */
export async function locate(
  read: SeekRead,
  from: WindowCursor,
  now: number,
  gallop: boolean,
): Promise<Located> {
  let reads = 0;
  const get = (ceiling: WindowCursor | null, full: boolean) => {
    if (++reads > SEEK_READS) throw new SeekLimitError();
    return read(ceiling, full);
  };
  const at = (seconds: number | null) =>
    seconds === null ? null : ceilingCursor(seconds);
  // No row is in [from, lo). `hi` overflows with `over`; null is the head.
  let lo = from.createdAt;
  let hi: number | null = null;
  let over: WindowPage | undefined;
  let found: WindowCursor | null | undefined;
  for (let span = DAY; found === undefined; span *= 2) {
    const ceiling =
      gallop && from.createdAt + span < now ? from.createdAt + span : null;
    const page = await get(at(ceiling), false);
    const outcome = classify(page, from);
    if (outcome === "fits") found = at(ceiling);
    else if (outcome === "overflow") {
      hi = ceiling;
      over = page;
      break;
    } else if (ceiling === null) return { kind: "newest" };
    else lo = ceiling;
  }
  while (found === undefined && (hi ?? now + 1) - lo > 1) {
    const mid = Math.floor((lo + (hi ?? now + 1)) / 2);
    const page = await get(at(mid), false);
    const outcome = classify(page, from);
    if (outcome === "fits") found = at(mid);
    else if (outcome === "empty") lo = mid;
    else {
      hi = mid;
      over = page;
    }
  }
  // More than a page of rows share one second: page down through it.
  let ceiling = at(hi);
  while (found === undefined) {
    const below = over?.cursor;
    if (!below) throw new SeekLimitError();
    const page = await get(below, false);
    const outcome = classify(page, from);
    // Nothing sought below `over`: it already holds the first sought row.
    if (outcome === "empty") found = ceiling;
    else if (outcome === "fits") found = below;
    else {
      ceiling = below;
      over = page;
    }
  }
  return { kind: "segment", page: await get(found, true), ceiling: found };
}
