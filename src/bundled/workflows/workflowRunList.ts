import type {
  WorkflowRun,
  WorkflowRunCursor,
  WorkflowRunPage,
} from "../../features/workflows/types";

/** One continuous run history, newest first, stitched from relay pages. The
 * relay orders runs by a creation time finer than the seconds a run carries, so
 * rows keep the order their pages gave them and are matched by ID, never
 * re-sorted. */
export type WorkflowRunList = Readonly<{
  runs: readonly WorkflowRun[];
  /** Reads the page after the last run; null once the oldest run is shown. */
  next: WorkflowRunCursor | null;
  /** For a run that ended a page, the cursor that reads the page after it. */
  after: ReadonlyMap<string, WorkflowRunCursor>;
  /** How many leading runs the newest page covers, so its reads refresh them. */
  newest: number;
}>;

export const emptyRunList: WorkflowRunList = Object.freeze({
  runs: Object.freeze([]),
  next: null,
  after: new Map(),
  newest: 0,
});

/** A run the relay can still move to another status. */
export const isActiveRun = (run: WorkflowRun) =>
  run.status === "pending" ||
  run.status === "running" ||
  run.status === "waiting_approval";

/** Cursors by the run they follow, for the runs still shown. */
function cursors(
  list: WorkflowRunList,
  runs: readonly WorkflowRun[],
  page: WorkflowRunPage,
) {
  const last = page.next && page.runs.at(-1)?.id;
  const after = new Map<string, WorkflowRunCursor>();
  for (const run of runs) {
    const cursor = run.id === last ? page.next : list.after.get(run.id);
    if (cursor) after.set(run.id, cursor);
  }
  return after;
}

const sameCursor = (
  a: WorkflowRunCursor | null | undefined,
  b: WorkflowRunCursor | null | undefined,
) => a?.before === b?.before && a?.beforeId === b?.beforeId;

/** `next`, or `list` itself when a read changed nothing a reader can see. A
 * run that reads the same keeps its object, so "nothing changed" is identity. */
function settle(list: WorkflowRunList, next: WorkflowRunList): WorkflowRunList {
  const shown = new Map(list.runs.map((run) => [run.id, run]));
  const runs = next.runs.map((run) => {
    const old = shown.get(run.id);
    return old && JSON.stringify(old) === JSON.stringify(run) ? old : run;
  });
  return next.newest === list.newest &&
    sameCursor(next.next, list.next) &&
    runs.length === list.runs.length &&
    runs.every((run, index) => run === list.runs[index]) &&
    next.after.size === list.after.size &&
    [...next.after].every(([id, cursor]) =>
      sameCursor(cursor, list.after.get(id)),
    )
    ? list
    : { ...next, runs };
}

/** A fresh newest page goes on top. Runs already shown below its last run stay.
 * When that run is not shown, more new runs arrived than one page holds (or the
 * shown ones are gone), so continuity is unknown and the page replaces the list. */
export function withNewest(
  list: WorkflowRunList,
  page: WorkflowRunPage,
): WorkflowRunList {
  const last = page.runs.at(-1);
  const joined = last ? list.runs.findIndex((run) => run.id === last.id) : -1;
  const fresh = new Set(page.runs.map((run) => run.id));
  const runs =
    joined < 0
      ? page.runs
      : [
          ...page.runs,
          ...list.runs.slice(joined + 1).filter((run) => !fresh.has(run.id)),
        ];
  return settle(list, {
    runs,
    next: joined < 0 ? page.next : list.next,
    after: cursors(joined < 0 ? emptyRunList : list, runs, page),
    newest: page.runs.length,
  });
}

/** The page `cursor` read goes on the end, unless the list has since moved on
 * from that cursor. A page that adds no run not already shown ends the history
 * whatever it claims: its cursor did not advance, and following it would read
 * the same page again. */
export function withOlder(
  list: WorkflowRunList,
  cursor: WorkflowRunCursor,
  page: WorkflowRunPage,
): WorkflowRunList {
  if (list.next !== cursor) return list;
  const shown = new Set(list.runs.map((run) => run.id));
  const added = page.runs.filter((run) => !shown.has(run.id));
  if (!added.length) return { ...list, next: null };
  const runs = [...list.runs, ...added];
  return {
    runs,
    next: page.next,
    after: cursors(list, runs, page),
    newest: list.newest,
  };
}

/** A re-read page updates the runs it holds where they are shown. */
export function withPage(
  list: WorkflowRunList,
  page: WorkflowRunPage,
): WorkflowRunList {
  const fresh = new Map(page.runs.map((run) => [run.id, run]));
  const runs = list.runs.map((run) => fresh.get(run.id) ?? run);
  return settle(list, { ...list, runs, after: cursors(list, runs, page) });
}

/** Cursors of the pages below the newest one that hold a run still active.
 * Consecutive page ends are at most a page apart, so the nearest cursor above
 * a run reads the page that holds it. */
export function activePages(list: WorkflowRunList): WorkflowRunCursor[] {
  const pages = new Set<WorkflowRunCursor>();
  let cursor: WorkflowRunCursor | undefined;
  list.runs.forEach((run, index) => {
    if (index >= list.newest && cursor && isActiveRun(run)) pages.add(cursor);
    cursor = list.after.get(run.id) ?? cursor;
  });
  return [...pages];
}
