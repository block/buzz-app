// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createLiveRuns } from "../../features/agent-types/live";
import type { RelaySession } from "../../features/relay/session";
import { LiveRunsAccessory } from "./LiveRunsAccessory";

beforeEach(() => {
  // The working avatar measures itself and asks whether motion is reduced.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bot = "b".repeat(64);
const root = "9".repeat(64);
const session = {
  profiles: {
    snapshot: () => new Map(),
    subscribe: () => () => {},
    ensure: async () => {},
  },
  media: () => undefined,
} as unknown as RelaySession;

function setup() {
  // Notify at once: these tests are about what is shown, not how often.
  const runs = createLiveRuns((flush) => flush());
  const open = (eventId: string, threadRootId = eventId) =>
    runs.open({
      agent: { id: "bot-1", pubkey: bot, name: "Coder" },
      channelId: "c1",
      eventId,
      threadRootId,
    });
  const show = (threadRootId?: string, channelId = "c1") =>
    render(
      <LiveRunsAccessory
        runs={runs}
        session={session}
        scope="test"
        channelId={channelId}
        threadRootId={threadRootId}
        canOpen={() => false}
        open={() => false}
      />,
    );
  return { open, show };
}
const rows = () =>
  screen.queryAllByRole("listitem").map((row) => row.textContent);

it("shows a run's steps as they arrive and drops the reply once it is published", () => {
  const { open, show } = setup();
  const view = show();
  const run = open("e1");
  // A run that reports nothing shows nothing.
  expect(view.container).toBeEmptyDOMElement();

  let command!: ReturnType<typeof run.live.step>;
  let reply!: ReturnType<typeof run.live.step>;
  act(() => {
    run.live.step({ kind: "thinking" }).finish();
    command = run.live.step({ kind: "command", label: "pnpm test" });
    run.live.step({ kind: "read" });
    reply = run.live.step({ kind: "message" });
  });
  expect(
    screen.getByRole("article", { name: "Coder is working" }),
  ).toBeVisible();
  expect(rows()).toEqual([
    "Thought",
    "Running pnpm test…",
    "Reading…",
    "Replying…",
  ]);

  act(() => {
    command.finish({ error: "exit 1" });
    reply.append("All ");
    reply.append("green.");
  });
  expect(rows()).toEqual([
    "Thought",
    "Ran pnpm testexit 1",
    "Reading…",
    "All green.",
  ]);

  act(() => reply.finish({ published: "f".repeat(64) }));
  expect(rows()).toEqual(["Thought", "Ran pnpm testexit 1", "Reading…"]);

  act(() => run.close());
  expect(view.container).toBeEmptyDOMElement();
});

it("folds all but the latest steps behind a count that expands", async () => {
  const { open, show } = setup();
  show();
  const run = open("e1");
  act(() => {
    for (const label of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"])
      run.live.step({ kind: "read", label }).finish();
  });
  expect(rows()).toEqual(["Read c.ts", "Read d.ts", "Read e.ts", "Read f.ts"]);
  const earlier = screen.getByRole("button", { name: "2 previous steps" });
  expect(earlier).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(earlier);
  expect(earlier).toHaveAttribute("aria-expanded", "true");
  expect(rows()).toHaveLength(6);
});

it("shows a run where its event is: the channel, or the thread it replies into", () => {
  const { open, show } = setup();
  act(() => {
    open("top").live.step({ kind: "search", label: "top-level" });
    open("reply", root).live.step({ kind: "tool", label: "threaded" });
  });
  show();
  expect(
    screen.getByRole("region", { name: "Agent runs in this channel" }),
  ).toBeVisible();
  expect(rows()).toEqual(["Searching top-level…"]);
  cleanup();
  show(root);
  expect(
    screen.getByRole("region", { name: "Agent runs in this thread" }),
  ).toBeVisible();
  expect(rows()).toEqual(["Using threaded…"]);
  cleanup();
  // The thread a top-level event starts shows its run too.
  show("top");
  expect(rows()).toEqual(["Searching top-level…"]);
  cleanup();
  expect(show(undefined, "c2").container).toBeEmptyDOMElement();
});
