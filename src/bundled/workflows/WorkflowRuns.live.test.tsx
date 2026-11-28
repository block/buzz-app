// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  WorkflowRun,
  WorkflowRunCursor,
  WorkflowRunPage,
} from "../../features/workflows/types";
import { WorkflowRuns } from "./WorkflowRuns";
import {
  createWorkflowFixture,
  fixtureDefinition,
  fixtureRun,
  fixtureView,
} from "./fixtures";
import {
  RUNS_ACTIVE_POLL_MS,
  RUNS_FAILED_POLL_MS,
  RUNS_QUIET_POLLS,
  RUNS_SETTLED_POLL_MS,
  WorkflowRunsCovered,
} from "./useWorkflowRunList";

const run = (
  name: string,
  status: WorkflowRun["status"] = "completed",
): WorkflowRun => ({
  ...fixtureRun,
  id: `${fixtureRun.id.slice(0, -1)}${name}`,
  status,
});
const NEWEST = "newest";
/** A relay holding `runs`, newest first, in pages of two. Reassign `runs` to
 * change what the next read returns; `reads` names each page read by the run
 * it follows. */
function relayOf(runs: WorkflowRun[]) {
  const fixture = createWorkflowFixture();
  const relay = {
    runs,
    reads: [] as string[],
    views: [] as ReturnType<typeof fixtureView<WorkflowRunPage>>[],
    fails: (_page: string) => false,
    /** Resolves when a read of this page may answer. */
    holds: (_page: string): Promise<void> | void => {},
    /** A cursor that does not advance: an older read answers with the first
     * page again. */
    stuck: false,
    /** This person's own Run now returns a run. */
    start() {
      act(() => {
        fixture.capability.trigger(fixtureDefinition);
        fixture.finish("succeeded");
      });
    },
    capability: fixture.capability,
  };
  const page = (cursor?: WorkflowRunCursor): WorkflowRunPage => {
    const start =
      cursor && !relay.stuck
        ? relay.runs.findIndex(({ id }) => id === cursor.beforeId) + 1
        : 0;
    const rows = relay.runs.slice(start, start + 2);
    const last = rows.at(-1);
    return {
      runs: rows,
      next:
        last && relay.runs.length > start + 2
          ? { before: "2026-09-12T12:00:00.123456Z", beforeId: last.id }
          : null,
    };
  };
  const empty: WorkflowRunPage = { runs: [], next: null };
  relay.capability = {
    ...fixture.capability,
    runs(_workflow, cursor) {
      const name = cursor ? cursor.beforeId.slice(-1) : NEWEST;
      const owned = fixtureView(empty);
      relay.views.push(owned);
      return {
        ...owned.view,
        // Like the session's views: data stays while loading, and a failed
        // read leaves none.
        async refresh() {
          // A list that reads without end fails its test instead of hanging it.
          if (relay.reads.length > 99) throw new Error("Runaway reads");
          relay.reads.push(name);
          owned.update({ ...owned.view.snapshot(), status: "loading" });
          await relay.holds(name);
          // A view disposed or cleared meanwhile has dropped this read.
          if (owned.disposed() || owned.view.snapshot().status !== "loading")
            return;
          owned.update(
            relay.fails(name)
              ? { status: "error", data: empty, error: "Read failed" }
              : { status: "ready", data: page(cursor) },
          );
        },
      };
    },
  };
  return relay;
}
const show = (relay: ReturnType<typeof relayOf>) =>
  render(
    <WorkflowRuns capability={relay.capability} workflow={fixtureDefinition} />,
  );
/** Each row as its status and the name its run was made with. */
const rows = () =>
  screen
    .queryAllByRole("article")
    .map(
      (row) =>
        `${row.querySelector("strong")?.textContent} ${row.querySelector(".workflow-key")?.textContent?.slice(-1)}`,
    );
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const olderButton = () =>
  screen.getByRole("button", { name: "Load older runs" });
/** The element whose arrival on screen loads the next page. */
const end = () =>
  olderButton().closest(".buzz-loading-region")?.parentElement as HTMLElement;
const region = () => screen.getByRole("region", { name: "Workflow runs" });
/** Replaces the browser's observer with one the test reports through. Like the
 * real one, a report reaches whichever observer watches the element now, so a
 * list hears about its end again only if it is still, or again, watching it. */
function observers() {
  const watching = new Map<Element, IntersectionObserverCallback>();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      readonly #report: IntersectionObserverCallback;
      constructor(report: IntersectionObserverCallback) {
        this.#report = report;
      }
      observe(target: Element) {
        watching.set(target, this.#report);
      }
      disconnect() {
        for (const [target, report] of watching)
          if (report === this.#report) watching.delete(target);
      }
    },
  );
  return async (target: Element, isIntersecting: boolean) => {
    const report = watching.get(target);
    if (!report) throw new Error("Nothing observes this element");
    act(() =>
      report(
        [{ target, isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    await advance(0);
  };
}
function setDocumentVisible(visible: boolean) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(
    visible ? "visible" : "hidden",
  );
  fireEvent(document, new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  // No spread on the poll interval, so a test can stand on either side of it.
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shows a new run on top by itself and keeps an open run's details open", async () => {
  const relay = relayOf([run("b"), run("a")]);
  show(relay);
  await advance(0);
  expect(rows()).toEqual(["Completed b", "Completed a"]);
  expect(screen.queryByRole("button", { name: "Refresh runs" })).toBeNull();
  const details = screen.getAllByRole("group")[1] as HTMLDetailsElement;
  details.open = true;

  relay.runs = [run("c", "running"), ...relay.runs];
  await advance(RUNS_SETTLED_POLL_MS - 1);
  expect(relay.reads).toEqual([NEWEST]);
  await advance(1);
  // "a" left the newest page of two and is still shown, in the same element.
  expect(rows()).toEqual(["Running c", "Completed b", "Completed a"]);
  expect(screen.getAllByRole("group")[2]).toBe(details);
  expect(details.open).toBe(true);

  // An active run brings the next read sooner, and it changes in place.
  relay.runs = [run("c", "failed"), ...relay.runs.slice(1)];
  await advance(RUNS_ACTIVE_POLL_MS);
  expect(rows()).toEqual(["Failed c", "Completed b", "Completed a"]);
  expect(relay.reads).toEqual([NEWEST, NEWEST, NEWEST]);
  // Nothing is active any more, so the quick interval ends.
  await advance(RUNS_ACTIVE_POLL_MS);
  expect(relay.reads).toHaveLength(3);
});

it("appends older runs and updates an active run on a later page in place", async () => {
  const relay = relayOf([
    run("d"),
    run("c"),
    run("b", "waiting_approval"),
    run("a", "running"),
  ]);
  show(relay);
  await advance(0);
  expect(rows()).toEqual(["Completed d", "Completed c"]);

  let release = () => {};
  relay.holds = (page) =>
    page === "c"
      ? new Promise<void>((resolve) => (release = resolve))
      : undefined;
  olderButton().focus();
  fireEvent.click(olderButton());
  // Activating it again while the page is read starts no second read.
  fireEvent.click(olderButton());
  await advance(999);
  expect(screen.queryByText("Reading older runs…")).toBeNull();
  // The loading line waits a second, and the control keeps focus meanwhile.
  await advance(1);
  expect(screen.getByText("Reading older runs…")).toHaveAttribute(
    "role",
    "status",
  );
  expect(olderButton()).toHaveFocus();
  expect(rows()).toEqual(["Completed d", "Completed c"]);
  release();
  relay.holds = () => {};
  await advance(0);
  expect(rows()).toEqual([
    "Completed d",
    "Completed c",
    "Waiting for approval b",
    "Running a",
  ]);
  // The oldest run is shown, so the control is gone and a line marks the end.
  expect(screen.queryByRole("button", { name: "Load older runs" })).toBeNull();
  expect(screen.queryByText("Reading older runs…")).toBeNull();
  expect(screen.getByText("No older runs.")).toBeVisible();
  expect(relay.reads).toEqual([NEWEST, "c"]);

  relay.runs = [run("d"), run("c"), run("b", "running"), run("a", "completed")];
  await advance(RUNS_ACTIVE_POLL_MS);
  expect(rows()).toEqual([
    "Completed d",
    "Completed c",
    "Running b",
    "Completed a",
  ]);
  // One read of the newest page and one of the page that holds both runs.
  expect(relay.reads.slice(2).sort()).toEqual(["c", NEWEST].sort());
  // Every view but the newest page's was a single read.
  expect(relay.views.map((view) => view.disposed())).toEqual([
    false,
    true,
    true,
  ]);
});

it("rereads at most two older pages with active runs per poll, taking turns", async () => {
  // A newest page and three older ones, each older one holding an active run.
  const relay = relayOf([
    run("h"),
    run("g"),
    run("f", "running"),
    run("e"),
    run("d", "waiting_approval"),
    run("c"),
    run("b", "pending"),
    run("a"),
  ]);
  show(relay);
  await advance(0);
  for (const _ of ["g", "e", "c"]) {
    fireEvent.click(olderButton());
    await advance(0);
  }
  expect(rows()).toHaveLength(8);
  expect(relay.reads).toEqual([NEWEST, "g", "e", "c"]);

  /** The pages one poll read below the newest page. */
  const poll = async () => {
    const from = relay.reads.length;
    await advance(RUNS_ACTIVE_POLL_MS);
    const reads = relay.reads.slice(from);
    // One poll, and it read the newest page once.
    expect(reads.filter((page) => page === NEWEST)).toEqual([NEWEST]);
    const older = reads.filter((page) => page !== NEWEST);
    expect(new Set(older).size).toBe(older.length);
    expect(older.length).toBeLessThanOrEqual(2);
    return older;
  };
  const skippedBy = (older: string[]) =>
    ["g", "e", "c"].filter((page) => !older.includes(page));
  let last = await poll();
  expect(last).toHaveLength(2);
  // No page waits more than one poll: the one a poll left out is in the next.
  for (let turn = 0; turn < 4; turn++) {
    const [skipped] = skippedBy(last);
    last = await poll();
    expect(last).toHaveLength(2);
    expect(last).toContain(skipped);
  }
});

it("reads nothing while hidden and catches up at once when shown again", async () => {
  const relay = relayOf([run("b", "running"), run("a")]);
  show(relay);
  await advance(0);
  setDocumentVisible(false);
  relay.runs = [run("c"), run("b", "completed"), run("a")];
  await advance(10 * RUNS_SETTLED_POLL_MS);
  expect(relay.reads).toEqual([NEWEST]);
  expect(rows()).toEqual(["Running b", "Completed a"]);

  setDocumentVisible(true);
  await advance(0);
  expect(relay.reads).toEqual([NEWEST, NEWEST]);
  expect(rows()).toEqual(["Completed c", "Completed b", "Completed a"]);

  // A brief absence costs no read: the next one keeps its place in time.
  await advance(10_000);
  setDocumentVisible(false);
  await advance(1_000);
  setDocumentVisible(true);
  await advance(RUNS_SETTLED_POLL_MS - 11_000 - 1);
  expect(relay.reads).toHaveLength(2);
  await advance(1);
  expect(relay.reads).toHaveLength(3);
});

it("pauses for a list that is off screen and loads older runs when its end is reached", async () => {
  const intersect = observers();
  const relay = relayOf(
    ["g", "f", "e", "d", "c", "b", "a"].map((name) => run(name)),
  );
  show(relay);
  await advance(0);
  const list = region();

  // A list scrolled away is not intersecting.
  await intersect(list, false);
  await advance(RUNS_SETTLED_POLL_MS);
  await intersect(end(), true);
  expect(relay.reads).toEqual([NEWEST]);

  // Shown again: its end being in reach, the next page is read, and the
  // newest page is reread at once.
  let release = () => {};
  relay.holds = (page) =>
    page === "f"
      ? new Promise<void>((resolve) => (release = resolve))
      : undefined;
  await intersect(list, true);
  expect(relay.reads).toEqual([NEWEST, "f", NEWEST]);
  // That page pushes the end out of reach, so reading stops there.
  await intersect(end(), false);
  release();
  await advance(0);
  expect(rows()).toHaveLength(4);
  expect(relay.reads).toEqual([NEWEST, "f", NEWEST]);
});

it("reads one older page each time the end of the list is reached", async () => {
  const intersect = observers();
  const relay = relayOf(
    ["g", "f", "e", "d", "c", "b", "a"].map((name) => run(name)),
  );
  show(relay);
  await advance(0);
  await intersect(end(), true);
  // The rows that page added moved the end, so where it was says nothing of
  // where it is. Nothing more is read until it is seen in reach again.
  expect(rows()).toHaveLength(4);
  expect(relay.reads).toEqual([NEWEST, "f"]);

  // Still in reach, as in a tall pane: one more page, and again only one.
  await intersect(end(), true);
  expect(rows()).toHaveLength(6);
  expect(relay.reads).toEqual([NEWEST, "f", "d"]);
  await intersect(end(), false);
  expect(relay.reads).toHaveLength(3);

  await intersect(end(), true);
  expect(rows()).toHaveLength(7);
  expect(relay.reads).toEqual([NEWEST, "f", "d", "b"]);
  // Scrolling took no control from under the reader, so focus is not moved.
  expect(screen.getByText("No older runs.")).toBeVisible();
  expect(document.body).toHaveFocus();
});

it("ends the history when an older page holds only runs already shown", async () => {
  const intersect = observers();
  const relay = relayOf([run("c"), run("b"), run("a")]);
  show(relay);
  await advance(0);
  relay.stuck = true;
  await intersect(end(), true);
  // Following that page's cursor would read it again, and again.
  expect(relay.reads).toEqual([NEWEST, "b"]);
  expect(rows()).toEqual(["Completed c", "Completed b"]);
  expect(screen.queryByRole("button", { name: "Load older runs" })).toBeNull();
  expect(screen.getByText("No older runs.")).toBeVisible();
});

it("tells a keyboard user what each load added and where the list ends", async () => {
  const relay = relayOf(["e", "d", "c", "b", "a"].map((name) => run(name)));
  show(relay);
  await advance(0);
  const button = olderButton();
  button.focus();
  fireEvent.click(button);
  await advance(0);
  // More remain: the control stays, focused, below the rows it added.
  expect(rows()).toHaveLength(4);
  expect(olderButton()).toBe(button);
  expect(button).toHaveFocus();
  const loaded = screen.getByText("2 older runs loaded.");
  expect(loaded).toHaveAttribute("role", "status");
  expect(screen.queryByText("No older runs.")).toBeNull();

  let release = () => {};
  relay.holds = () => new Promise<void>((resolve) => (release = resolve));
  fireEvent.click(button);
  await advance(0);
  // Cleared while reading, so a page of the same size is announced again.
  expect(loaded).toBeEmptyDOMElement();
  release();
  await advance(0);
  // The last page: the control leaves, and its focus goes to the line that
  // marks the end of the list rather than to the document.
  expect(rows()).toHaveLength(5);
  expect(button).not.toBeInTheDocument();
  expect(loaded).toHaveTextContent("1 older run loaded.");
  expect(screen.getByText("No older runs.")).toHaveFocus();
});

it("starts over from the newest page when more runs arrived than it holds", async () => {
  const relay = relayOf(["e", "d", "c", "b", "a"].map((name) => run(name)));
  show(relay);
  await advance(0);
  const button = olderButton();
  button.focus();
  fireEvent.click(button);
  await advance(0);
  expect(rows()).toHaveLength(4);
  (screen.getAllByRole("group")[3] as HTMLDetailsElement).open = true;

  // The page after "b" is being read when three runs arrive, one more than a
  // page. "e" is no longer on the newest page, so what lies between is unknown.
  let release = () => {};
  relay.holds = (page) =>
    page === "b"
      ? new Promise<void>((resolve) => (release = resolve))
      : undefined;
  fireEvent.click(button);
  relay.runs = [run("h"), run("g"), run("f"), ...relay.runs];
  await advance(RUNS_SETTLED_POLL_MS);
  // Known limit: the older pages, and an open run's details with them, go.
  expect(rows()).toEqual(["Completed h", "Completed g"]);
  release();
  relay.holds = () => {};
  await advance(0);
  // The read that was under way belongs to the list that was replaced.
  expect(rows()).toEqual(["Completed h", "Completed g"]);
  expect(relay.reads).toEqual([NEWEST, "d", "b", NEWEST]);
  expect(screen.queryByText("No older runs.")).toBeNull();
  // The control stayed, with focus, and reads on from the new end.
  expect(olderButton()).toBe(button);
  expect(button).toHaveFocus();
  expect(button).toBeEnabled();
  fireEvent.click(button);
  await advance(0);
  expect(rows()).toEqual([
    "Completed h",
    "Completed g",
    "Completed f",
    "Completed e",
  ]);
  expect(relay.reads.at(-1)).toBe("g");
});

it("keeps the runs shown when an older page fails, and retries on request", async () => {
  const relay = relayOf([run("c"), run("b"), run("a")]);
  show(relay);
  await advance(0);
  relay.fails = (page) => page === "b";
  fireEvent.click(olderButton());
  await advance(0);
  expect(rows()).toEqual(["Completed c", "Completed b"]);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Older runs could not be read. Retry with Load older runs.",
  );
  // The newest page is fine, so its own retry is not offered.
  expect(screen.queryByRole("button", { name: "Refresh runs" })).toBeNull();

  relay.fails = () => false;
  fireEvent.click(olderButton());
  await advance(0);
  expect(rows()).toEqual(["Completed c", "Completed b", "Completed a"]);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the runs shown when a reread fails, backs off, and recovers", async () => {
  const relay = relayOf([run("b", "running"), run("a")]);
  show(relay);
  await advance(0);
  relay.fails = () => true;
  await advance(RUNS_ACTIVE_POLL_MS);
  expect(rows()).toEqual(["Running b", "Completed a"]);
  expect(screen.getByRole("alert")).toHaveTextContent("Read failed");
  expect(screen.getByRole("button", { name: "Refresh runs" })).toBeEnabled();
  expect(relay.reads).toHaveLength(2);

  // A failing relay is asked less often than a working one.
  relay.fails = () => false;
  relay.runs = [run("b", "completed"), run("a")];
  await advance(RUNS_FAILED_POLL_MS - 1);
  expect(relay.reads).toHaveLength(2);
  await advance(1);
  expect(rows()).toEqual(["Completed b", "Completed a"]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Refresh runs" })).toBeNull();
});

it("keeps the error line and Refresh runs in place, focus and all, while a failing read is retried", async () => {
  const relay = relayOf([run("b"), run("a")]);
  show(relay);
  await advance(0);
  relay.fails = () => true;
  await advance(RUNS_SETTLED_POLL_MS);
  const alert = screen.getByRole("alert");
  const refresh = screen.getByRole("button", { name: "Refresh runs" });
  refresh.focus();

  // The retry is under way: the view is loading and holds no error.
  let release = () => {};
  relay.holds = () => new Promise<void>((resolve) => (release = resolve));
  await advance(RUNS_FAILED_POLL_MS);
  expect(relay.reads).toHaveLength(3);
  const unmoved = () => {
    expect(screen.getByRole("alert")).toBe(alert);
    expect(alert).toHaveTextContent("Read failed");
    expect(screen.getByRole("button", { name: "Refresh runs" })).toBe(refresh);
    expect(refresh).toHaveFocus();
    expect(refresh).toBeEnabled();
    expect(rows()).toEqual(["Completed b", "Completed a"]);
  };
  unmoved();
  // It fails again, and nothing has moved.
  release();
  await advance(0);
  unmoved();

  // Asked for, a retry shows on the control, which stays focused meanwhile.
  relay.fails = () => false;
  fireEvent.click(refresh);
  await advance(0);
  expect(relay.reads).toHaveLength(4);
  expect(refresh).toHaveAttribute("aria-busy", "true");
  expect(refresh).toHaveFocus();
  expect(screen.getByRole("alert")).toBe(alert);
  // A read that succeeds retires both. The control's focus goes to the list
  // rather than to the document.
  release();
  await advance(0);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(refresh).not.toBeInTheDocument();
  expect(region()).toHaveFocus();
});

it("slows its rereads of an active run that stays the same, until a change or the person's own run", async () => {
  const relay = relayOf([run("b", "waiting_approval"), run("a")]);
  show(relay);
  await advance(0);
  const reads = () => relay.reads.length;
  /** Rereads at the active interval until that many have changed nothing. */
  const quiet = async () => {
    for (let poll = 1; poll <= RUNS_QUIET_POLLS; poll++) {
      const before = reads();
      await advance(RUNS_ACTIVE_POLL_MS - 1);
      expect(reads()).toBe(before);
      await advance(1);
      expect(reads()).toBe(before + 1);
    }
  };
  await quiet();
  // Each further wait doubles, as far as the settled interval.
  for (const wait of [
    2 * RUNS_ACTIVE_POLL_MS,
    4 * RUNS_ACTIVE_POLL_MS,
    RUNS_SETTLED_POLL_MS,
    RUNS_SETTLED_POLL_MS,
  ]) {
    const before = reads();
    await advance(wait - 1);
    expect(reads()).toBe(before);
    await advance(1);
    expect(reads()).toBe(before + 1);
  }

  // A run that changed is watched closely again.
  relay.runs = [run("b", "running"), run("a")];
  await advance(RUNS_SETTLED_POLL_MS);
  expect(rows()).toEqual(["Running b", "Completed a"]);
  await quiet();
  const slowed = reads();
  await advance(RUNS_ACTIVE_POLL_MS);
  expect(reads()).toBe(slowed);

  // So is one the person just started: read at once, then at the active pace.
  relay.runs = [run("c", "pending"), ...relay.runs];
  relay.start();
  await advance(0);
  expect(rows()[0]).toBe("Pending c");
  expect(reads()).toBe(slowed + 1);
  await advance(RUNS_ACTIVE_POLL_MS);
  expect(reads()).toBe(slowed + 2);
});

it("stops polling under a dialog its host has open and catches up when uncovered", async () => {
  const relay = relayOf([run("b", "running"), run("a")]);
  const under = (covered: boolean) => (
    <WorkflowRunsCovered.Provider value={covered}>
      <WorkflowRuns
        capability={relay.capability}
        workflow={fixtureDefinition}
      />
    </WorkflowRunsCovered.Provider>
  );
  const view = render(under(false));
  await advance(0);
  view.rerender(under(true));
  await advance(10 * RUNS_SETTLED_POLL_MS);
  expect(relay.reads).toEqual([NEWEST]);
  view.rerender(under(false));
  await advance(0);
  expect(relay.reads).toEqual([NEWEST, NEWEST]);

  // A run the person starts from that dialog shows as soon as it closes,
  // however recently the list last read.
  view.rerender(under(true));
  relay.runs = [run("c", "pending"), ...relay.runs];
  relay.start();
  await advance(0);
  expect(relay.reads).toHaveLength(2);
  view.rerender(under(false));
  await advance(0);
  expect(rows()[0]).toBe("Pending c");
  expect(relay.reads).toHaveLength(3);
});

it("keeps the list, open details and all, when its view is replaced for the same workflow", async () => {
  const relay = relayOf([run("b"), run("a")]);
  const view = show(relay);
  await advance(0);
  const list = region();
  const details = screen.getAllByRole("group")[0] as HTMLDetailsElement;
  details.open = true;
  // As when the editor's save readback hands the list a new definition.
  view.rerender(
    <WorkflowRuns
      capability={relay.capability}
      workflow={{ ...fixtureDefinition }}
    />,
  );
  // The new view has read nothing yet.
  expect(screen.queryByText("Reading runs…")).toBeNull();
  expect(region()).toBe(list);
  await advance(0);
  expect(region()).toBe(list);
  expect(screen.getAllByRole("group")[0]).toBe(details);
  expect(details.open).toBe(true);
  expect(rows()).toEqual(["Completed b", "Completed a"]);
  expect(relay.views.map((owned) => owned.disposed())).toEqual([true, false]);
});

it("says a workflow has no runs yet without flickering on each reread", async () => {
  const relay = relayOf([]);
  show(relay);
  expect(screen.getByText("Reading runs…")).toBeVisible();
  await advance(0);
  expect(screen.getByText("No runs yet.")).toBeVisible();
  let release = () => {};
  relay.holds = () => new Promise<void>((resolve) => (release = resolve));
  await advance(RUNS_SETTLED_POLL_MS);
  expect(relay.reads).toHaveLength(2);
  expect(screen.getByText("No runs yet.")).toBeVisible();
  expect(screen.queryByText("Reading runs…")).toBeNull();
  release();
});

it("stops reading once it is unmounted", async () => {
  const relay = relayOf([run("c", "running"), run("b"), run("a")]);
  const view = show(relay);
  await advance(0);
  let started = false;
  relay.holds = (page) => {
    if (page !== "b") return;
    started = true;
    return new Promise<void>(() => {});
  };
  fireEvent.click(olderButton());
  await advance(0);
  expect(started).toBe(true);
  view.unmount();
  // The read still under way is released with the list.
  expect(relay.views.every((owned) => owned.disposed())).toBe(true);
  const reads = relay.reads.length;
  await advance(10 * RUNS_SETTLED_POLL_MS);
  expect(relay.reads).toHaveLength(reads);
});

it("drops the runs the session cleared and waits for a refresh", async () => {
  const relay = relayOf([run("b", "running"), run("a")]);
  show(relay);
  await advance(0);
  act(() =>
    relay.views[0]?.update({ status: "idle", data: { runs: [], next: null } }),
  );
  expect(rows()).toEqual([]);
  expect(
    screen.getByText("History cleared. Refresh to read it again."),
  ).toBeVisible();
  await advance(10 * RUNS_SETTLED_POLL_MS);
  expect(relay.reads).toEqual([NEWEST]);

  fireEvent.click(screen.getByRole("button", { name: "Refresh runs" }));
  await advance(0);
  expect(rows()).toEqual(["Running b", "Completed a"]);
  await advance(RUNS_ACTIVE_POLL_MS);
  expect(relay.reads).toEqual([NEWEST, NEWEST, NEWEST]);
});

it("does not reread history the session cleared while a read for the person's own run was queued", async () => {
  const relay = relayOf([run("b", "running"), run("a")]);
  show(relay);
  await advance(0);
  let release = () => {};
  relay.holds = () => new Promise<void>((resolve) => (release = resolve));
  await advance(RUNS_ACTIVE_POLL_MS);
  expect(relay.reads).toHaveLength(2);
  // Run now returns a run while that read is under way, which queues another.
  relay.start();
  act(() =>
    relay.views[0]?.update({ status: "idle", data: { runs: [], next: null } }),
  );
  release();
  await advance(0);
  expect(relay.reads).toHaveLength(2);
  expect(
    screen.getByText("History cleared. Refresh to read it again."),
  ).toBeVisible();
});
