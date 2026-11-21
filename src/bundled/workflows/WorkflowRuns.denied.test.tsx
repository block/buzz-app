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
import { createWorkflows } from "../../features/workflows/capability";
import { workflowHost } from "../../features/workflows/http";
import { WorkflowRuns } from "./WorkflowRuns";
import { fixtureDefinition, fixtureRun, fixtureViewer } from "./fixtures";
import {
  RUNS_ACTIVE_POLL_MS,
  RUNS_SETTLED_POLL_MS,
} from "./useWorkflowRunList";

const REFUSED =
  "The relay refused to show this workflow’s runs, so the ones shown here were removed. Retry with Refresh runs.";
const NEWEST = "newest";
type Status = "completed" | "running";
const runId = (name: string) => `${fixtureRun.id.slice(0, -1)}${name}`;
/** The session's real capability over a relay answering in pages of two. The
 * person's local membership never changes: `canAccess` stays true while the
 * relay answers `status(page)`, so a 403 here is the relay's word alone.
 * `reads` names each page read by the run it follows. */
function relayOf(runs: [name: string, status: Status][]) {
  const relay = {
    runs,
    reads: [] as string[],
    /** The HTTP status the relay gives a read of this page. */
    status: (_page: string) => 200,
    /** Resolves when a read of this page may answer. */
    holds: (_page: string): Promise<void> | void => {},
  };
  return Object.assign(relay, {
    capability: createWorkflows({
      reader: undefined,
      viewer: fixtureViewer,
      outbox: undefined,
      local: undefined,
      canAccess: () => true,
      host: workflowHost(async (_route, body) => {
        const cursor = (body as { cursor?: { beforeId: string } }).cursor;
        const name = cursor ? cursor.beforeId.slice(-1) : NEWEST;
        if (relay.reads.length > 99) throw new Error("Runaway reads");
        relay.reads.push(name);
        const status = relay.status(name);
        await relay.holds(name);
        if (status !== 200)
          return Response.json(
            { error: status === 403 ? "not a channel member" : "unavailable" },
            { status },
          );
        const start = cursor
          ? relay.runs.findIndex(([run]) => run === name) + 1
          : 0;
        const rows = relay.runs.slice(start, start + 2);
        const last = rows.at(-1);
        return Response.json({
          runs: rows.map(([run, state]) => ({
            id: runId(run),
            workflow_id: fixtureDefinition.id,
            status: state,
            current_step: 1,
            execution_trace: [{ secret: `trace of ${run}` }],
            created_at: fixtureRun.createdAt,
            started_at: fixtureRun.startedAt,
            completed_at: state === "completed" ? fixtureRun.completedAt : null,
            error_code: null,
            error_message: null,
          })),
          next:
            last && relay.runs.length > start + 2
              ? {
                  before: "2026-09-12T12:00:00.123456Z",
                  before_id: runId(last[0]),
                }
              : null,
        });
      }),
    }).capability,
  });
}
const show = (relay: ReturnType<typeof relayOf>) =>
  render(
    <WorkflowRuns capability={relay.capability} workflow={fixtureDefinition} />,
  );
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
/** No run, no trace, the reason, and the one way back. */
function expectPurged(container: HTMLElement) {
  expect(rows()).toEqual([]);
  expect(container).not.toHaveTextContent("trace of");
  expect(screen.getByRole("alert")).toHaveTextContent(REFUSED);
  expect(screen.queryByText("No runs yet.")).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh runs" })).toBeEnabled();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("removes the runs and an open trace when the relay refuses the newest page, and reads again only on request", async () => {
  const relay = relayOf([
    ["b", "completed"],
    ["a", "completed"],
  ]);
  const { container } = show(relay);
  await advance(0);
  expect(rows()).toEqual(["Completed b", "Completed a"]);
  const details = container.querySelector("details") as HTMLDetailsElement;
  details.open = true;
  expect(details).toHaveTextContent("trace of b");

  relay.status = () => 403;
  await advance(RUNS_SETTLED_POLL_MS);
  expect(relay.reads).toEqual([NEWEST, NEWEST]);
  expectPurged(container);

  // A workflow the relay refuses is not asked about again unasked.
  await advance(10 * RUNS_SETTLED_POLL_MS);
  expect(relay.reads).toHaveLength(2);

  // Still refused: the same line, and still no polling.
  fireEvent.click(screen.getByRole("button", { name: "Refresh runs" }));
  await advance(0);
  expect(relay.reads).toHaveLength(3);
  expectPurged(container);

  relay.status = () => 200;
  fireEvent.click(screen.getByRole("button", { name: "Refresh runs" }));
  await advance(0);
  expect(rows()).toEqual(["Completed b", "Completed a"]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Refresh runs" })).toBeNull();
  await advance(RUNS_SETTLED_POLL_MS);
  expect(relay.reads).toHaveLength(5);
});

it("removes every run when the relay refuses an older page", async () => {
  const relay = relayOf([
    ["c", "completed"],
    ["b", "completed"],
    ["a", "completed"],
  ]);
  const { container } = show(relay);
  await advance(0);
  relay.status = (page: string) => (page === "b" ? 403 : 200);
  fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
  await advance(0);
  expect(relay.reads).toEqual([NEWEST, "b"]);
  expectPurged(container);
  expect(screen.queryByRole("button", { name: "Load older runs" })).toBeNull();
  await advance(10 * RUNS_SETTLED_POLL_MS);
  expect(relay.reads).toHaveLength(2);
});

it("removes every run when the relay refuses the reread of a page with an active run", async () => {
  const relay = relayOf([
    ["d", "completed"],
    ["c", "completed"],
    ["b", "running"],
    ["a", "completed"],
  ]);
  const { container } = show(relay);
  await advance(0);
  fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
  await advance(0);
  expect(rows()).toHaveLength(4);

  // The newest page still reads; only the page holding the active run does not.
  relay.status = (page: string) => (page === "c" ? 403 : 200);
  await advance(RUNS_ACTIVE_POLL_MS);
  expect(relay.reads).toEqual([NEWEST, "c", NEWEST, "c"]);
  expectPurged(container);
  await advance(10 * RUNS_SETTLED_POLL_MS);
  expect(relay.reads).toHaveLength(4);
});

it.each([429, 503])(
  "keeps the runs shown when a read fails with %i",
  async (status) => {
    const relay = relayOf([
      ["d", "completed"],
      ["c", "completed"],
      ["b", "running"],
      ["a", "completed"],
    ]);
    const { container } = show(relay);
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await advance(0);
    relay.status = () => status;
    await advance(RUNS_ACTIVE_POLL_MS);
    expect(relay.reads).toEqual([NEWEST, "c", NEWEST, "c"]);
    expect(rows()).toHaveLength(4);
    expect(container).toHaveTextContent("trace of b");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't read workflow data. Try again.",
    );
  },
);

it.each([200, 503])(
  "stays empty when a read that was under way answers %i after the refusal",
  async (late) => {
    const relay = relayOf([
      ["d", "completed"],
      ["c", "completed"],
      ["b", "running"],
      ["a", "completed"],
    ]);
    const { container } = show(relay);
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await advance(0);

    // One poll reads both pages. The older one is refused at once while the
    // newest, which the relay answers otherwise, is still on its way.
    let release = () => {};
    relay.status = (page: string) => (page === "c" ? 403 : late);
    relay.holds = (page: string) =>
      page === NEWEST
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : undefined;
    await advance(RUNS_ACTIVE_POLL_MS);
    expect(relay.reads).toEqual([NEWEST, "c", NEWEST, "c"]);
    expectPurged(container);

    release();
    await advance(0);
    expectPurged(container);
    await advance(10 * RUNS_SETTLED_POLL_MS);
    expect(relay.reads).toHaveLength(4);
  },
);

it("stays empty when the reread of an older page answers after the newest page was refused", async () => {
  const relay = relayOf([
    ["d", "completed"],
    ["c", "completed"],
    ["b", "running"],
    ["a", "completed"],
  ]);
  const { container } = show(relay);
  await advance(0);
  fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
  await advance(0);

  let release = () => {};
  relay.status = (page: string) => (page === NEWEST ? 403 : 200);
  relay.holds = (page: string) =>
    page === "c"
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : undefined;
  await advance(RUNS_ACTIVE_POLL_MS);
  expectPurged(container);

  release();
  await advance(0);
  expectPurged(container);
});

it("does not take a read begun before the refusal as the answer to Refresh runs", async () => {
  const relay = relayOf([
    ["d", "completed"],
    ["c", "completed"],
    ["b", "running"],
    ["a", "completed"],
  ]);
  const { container } = show(relay);
  await advance(0);
  fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
  await advance(0);
  let release = () => {};
  relay.status = (page: string) => (page === "c" ? 403 : 200);
  relay.holds = (page: string) =>
    page === NEWEST
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : undefined;
  await advance(RUNS_ACTIVE_POLL_MS);
  expectPurged(container);

  // The newest page is still being read when the person asks again.
  relay.holds = () => {};
  fireEvent.click(screen.getByRole("button", { name: "Refresh runs" }));
  await advance(0);
  expect(relay.reads).toHaveLength(4);
  expect(rows()).toEqual([]);
  release();
  await advance(0);
  // That read's answer is dropped and the page is read afresh.
  expect(relay.reads).toEqual([NEWEST, "c", NEWEST, "c", NEWEST]);
  expect(rows()).toEqual(["Completed d", "Completed c"]);
  expect(screen.queryByRole("alert")).toBeNull();
});
