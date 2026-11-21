import { expect, it } from "vitest";
import type {
  WorkflowRun,
  WorkflowRunPage,
} from "../../features/workflows/types";
import {
  activePages,
  emptyRunList,
  withNewest,
  withOlder,
  withPage,
} from "./workflowRunList";

const run = (
  id: string,
  status: WorkflowRun["status"] = "completed",
): WorkflowRun => ({
  id,
  workflowId: "workflow",
  status,
  currentStep: 0,
  trace: [],
  // One second for every run: only page order can place them.
  createdAt: 1_789_224_000,
  startedAt: 1_789_224_000,
  completedAt: null,
  errorCode: null,
  errorMessage: null,
});
const cursor = (beforeId: string) => ({ before: "t", beforeId });
/** A relay page: `next` follows its last run, as the relay builds it. */
const page = (runs: WorkflowRun[], more = true): WorkflowRunPage => ({
  runs,
  next: more ? cursor(runs.at(-1)?.id ?? "") : null,
});
const ids = (list: { runs: readonly WorkflowRun[] }) =>
  list.runs.map(({ id }) => id);

it("puts new runs on top and keeps the older runs already shown", () => {
  const first = withNewest(emptyRunList, page([run("c"), run("b")]));
  const older = first.next;
  if (!older) throw new Error("expected an older page");
  const shown = withOlder(first, older, page([run("a")], false));
  expect(ids(shown)).toEqual(["c", "b", "a"]);
  expect(shown.next).toBeNull();

  // "d" is new; the page ends at "c", so "b" and "a" below it stay.
  const next = withNewest(shown, page([run("d", "running"), run("c")]));
  expect(ids(next)).toEqual(["d", "c", "b", "a"]);
  expect(next.next).toBeNull();
  expect(next.newest).toBe(2);
});

it("replaces a run the newest page reads again", () => {
  const first = withNewest(emptyRunList, page([run("b", "running")], false));
  const next = withNewest(first, page([run("b", "completed")], false));
  expect(next.runs.map(({ status }) => status)).toEqual(["completed"]);
});

it("starts over when the newest page no longer reaches the shown runs", () => {
  const shown = withNewest(emptyRunList, page([run("b"), run("a")]));
  const next = withNewest(shown, page([run("z"), run("y")]));
  expect(ids(next)).toEqual(["z", "y"]);
  expect(next.next).toEqual(cursor("y"));
  expect([...next.after.keys()]).toEqual(["y"]);
});

it("empties the list when the relay holds no runs", () => {
  const shown = withNewest(emptyRunList, page([run("a")], false));
  expect(withNewest(shown, { runs: [], next: null })).toMatchObject({
    runs: [],
    next: null,
    newest: 0,
  });
});

it("appends an older page only for the cursor the list still ends on", () => {
  const first = withNewest(emptyRunList, page([run("c"), run("b")]));
  const older = first.next;
  if (!older) throw new Error("expected an older page");
  // The list moved on before this read came back.
  const moved = withNewest(first, page([run("z"), run("y")]));
  expect(withOlder(moved, older, page([run("a")], false))).toBe(moved);
  // A page with no runs ends the history even if it names another page.
  expect(withOlder(first, older, { runs: [], next: cursor("x") }).next).toBe(
    null,
  );
  // So does a page of runs already shown: its cursor did not advance, and
  // following it would read that page again.
  const stuck = withOlder(first, older, page([run("c"), run("b")]));
  expect(ids(stuck)).toEqual(["c", "b"]);
  expect(stuck.next).toBeNull();
  expect(stuck.after).toBe(first.after);
  // A run both pages hold is shown once.
  expect(
    ids(withOlder(first, older, page([run("b"), run("a")], false))),
  ).toEqual(["c", "b", "a"]);
});

it("updates a re-read page's runs where they are shown", () => {
  const first = withNewest(emptyRunList, page([run("c"), run("b")]));
  const older = first.next;
  if (!older) throw new Error("expected an older page");
  const shown = withOlder(first, older, page([run("a", "running")], false));
  const next = withPage(shown, page([run("a", "failed"), run("gone")], false));
  expect(ids(next)).toEqual(["c", "b", "a"]);
  expect(next.runs.at(-1)?.status).toBe("failed");
});

it("is the same list after a read that changed nothing", () => {
  const first = withNewest(emptyRunList, page([run("c", "running"), run("b")]));
  const older = first.next;
  if (!older) throw new Error("expected an older page");
  const shown = withOlder(first, older, page([run("a", "running")], false));
  // Every read parses new objects, so only what they say can be compared.
  expect(withNewest(shown, page([run("c", "running"), run("b")]))).toBe(shown);
  expect(withPage(shown, page([run("a", "running")], false))).toBe(shown);

  // A run that did change is replaced, and the others keep their objects.
  const next = withNewest(shown, page([run("c", "completed"), run("b")]));
  expect(next).not.toBe(shown);
  expect(next.runs[0]?.status).toBe("completed");
  expect(next.runs.slice(1)).toEqual(shown.runs.slice(1));
  expect(next.runs[1]).toBe(shown.runs[1]);
  expect(next.runs[2]).toBe(shown.runs[2]);
  // The list keeps its end, so a read of the next page still belongs to it.
  expect(next.next).toBe(shown.next);
});

it("names the page to re-read for an active run below the newest page", () => {
  const first = withNewest(emptyRunList, page([run("d", "running"), run("c")]));
  // The newest page's own reads cover an active run it holds.
  expect(activePages(first)).toEqual([]);
  const older = first.next;
  if (!older) throw new Error("expected an older page");
  const shown = withOlder(
    first,
    older,
    page([run("b", "waiting_approval"), run("a", "pending")], false),
  );
  // Both active runs sit on the one page after "c".
  expect(activePages(shown)).toEqual([cursor("c")]);

  // A new run pushes "c" off the newest page. "b" and "a" still follow "c".
  const pushed = withNewest(shown, page([run("e"), run("d", "running")]));
  expect(ids(pushed)).toEqual(["e", "d", "c", "b", "a"]);
  expect(activePages(pushed)).toEqual([cursor("c")]);
  // Once "c" itself is active, the page after "d" is the one that holds it.
  const active = withPage(pushed, page([run("c", "running")]));
  expect(activePages(active)).toEqual([cursor("d"), cursor("c")]);
  // A newest page that reaches "c" covers it, though "d" still has a cursor
  // above it. Only the page after "c", with "b" and "a", is left to re-read.
  const covered = withNewest(
    active,
    page([run("e"), run("d", "running"), run("c", "running")]),
  );
  expect(ids(covered)).toEqual(["e", "d", "c", "b", "a"]);
  expect(activePages(covered)).toEqual([cursor("c")]);
});
