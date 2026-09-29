// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageRow } from "./MessageRow";
import { ReplySummary } from "./ReplySummary";
import { threadThinkingFixture } from "./thread-thinking-testing";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("shows exact-thread work before a first reply, opens that thread and clears on completion or loss of freshness", async () => {
  vi.useFakeTimers();
  const f = await threadThinkingFixture();
  await f.session.profiles.ensure([f.agent]);
  const open = vi.fn();
  const props = {
    session: f.session,
    profile: undefined,
    media: f.session.media,
    onOpenLink: () => false,
    onOpenThread: open,
    day: false,
    retry: undefined,
  };
  try {
    render(
      <>
        <MessageRow {...props} row={f.first} />
        <MessageRow {...props} row={f.second} />
      </>,
    );
    act(() => f.observe("turn_started", "unlinked"));
    expect(screen.queryByRole("button", { name: /working/ })).toBeNull();
    act(() => f.start(f.first.id));
    const summary = screen.getByRole("button", {
      name: "View thread: Buzzy working…",
    });
    expect(screen.getAllByRole("button", { name: /working/ })).toHaveLength(1);
    fireEvent.click(summary);
    expect(open).toHaveBeenCalledWith(f.first.id, f.first.id);
    act(() => f.respond(f.first.id));
    expect(screen.queryByRole("button", { name: /working/ })).toBeNull();
    act(() => {
      f.signal(f.second.id);
    });
    expect(screen.getByRole("button", { name: /working/ })).toBeVisible();
    act(() => vi.advanceTimersByTime(9000));
    expect(screen.queryByRole("button", { name: /working/ })).toBeNull();
  } finally {
    cleanup();
    await f.dispose();
  }
});

it("moves active agents to the right, keeps overflow to their left, and restores ordinary reply counts", () => {
  const props = {
    count: 8,
    participants: ["Buzzy", "Alex", "Bea", "Cam", "Drew"],
    resolveName: (_id: string, name: string) => name,
    media: () => undefined,
  };
  const view = render(
    <ReplySummary
      {...props}
      workingAgents={["Buzzy", "Rivet"]}
      workingLabel="2 agents working…"
    />,
  );
  const stack = view.container.querySelector('[aria-hidden="true"]');
  if (!stack) throw new Error("Missing thread avatar stack");
  expect(
    [...stack.querySelectorAll("[title]")].map((node) =>
      node.getAttribute("title"),
    ),
  ).toEqual(["Alex", "Buzzy", "Rivet"]);
  expect(stack.firstElementChild).toHaveTextContent("+3");
  expect(stack.lastElementChild).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  expect(screen.getByText("2 agents working…")).toHaveClass("buzz-shimmer");
  view.rerender(<ReplySummary {...props} />);
  expect(screen.getByText("8 replies")).toBeVisible();
  expect(
    [...stack.querySelectorAll("[title]")].map((node) =>
      node.getAttribute("title"),
    ),
  ).toEqual(["Bea", "Alex", "Buzzy"]);
  expect(screen.queryByText(/working/)).toBeNull();
});

it("keeps the three latest distinct responders with the newest rightmost as replies arrive", () => {
  const props = {
    count: 5,
    participants: ["Buzzy", "Alex", "Bea", "Cam"],
    resolveName: (_id: string, name: string) => name,
    media: () => undefined,
  };
  const view = render(<ReplySummary {...props} />);
  const names = () =>
    [...view.container.querySelectorAll("[data-avatar-shape][title]")].map(
      (node) => node.getAttribute("title"),
    );
  expect(names()).toEqual(["Bea", "Alex", "Buzzy"]);
  view.rerender(
    <ReplySummary {...props} participants={["Alex", "Buzzy", "Bea", "Cam"]} />,
  );
  expect(names()).toEqual(["Bea", "Buzzy", "Alex"]);
  view.rerender(
    <ReplySummary
      {...props}
      workingAgents={["Buzzy"]}
      workingLabel="Buzzy working…"
      participants={["Alex", "Buzzy", "Bea", "Cam"]}
    />,
  );
  expect(names()).toEqual(["Bea", "Alex", "Buzzy"]);
  view.rerender(
    <ReplySummary {...props} participants={["Buzzy", "Alex", "Bea", "Cam"]} />,
  );
  expect(names()).toEqual(["Bea", "Alex", "Buzzy"]);
});

it("names multiple working agents by count, bounds active avatars with an overflow count, and restores a neutral action on completion", async () => {
  const f = await threadThinkingFixture();
  const agents = ["a", "b", "c", "d"].map((value) => value.repeat(64));
  const props = {
    session: f.session,
    profile: undefined,
    media: f.session.media,
    onOpenLink: () => false,
    onOpenThread: () => {},
    day: false,
    retry: undefined,
  };
  try {
    const view = render(
      <MessageRow
        {...props}
        row={{ ...f.first, replyCount: 4, participants: agents }}
      />,
    );
    act(() =>
      agents.forEach((agent, i) => {
        f.observe(
          "turn_started",
          `multi-${i}`,
          { triggeringEventIds: [f.first.id] },
          agent,
        );
      }),
    );
    const summary = screen.getByRole("button", {
      name: "View thread: 4 agents working…",
    });
    expect(summary.querySelectorAll("[data-avatar-shape][title]")).toHaveLength(
      3,
    );
    expect(summary).toHaveTextContent("+1");
    act(() => f.observe("turn_completed", "multi-3", {}, agents[3]));
    expect(
      screen.getByRole("button", { name: "View thread: 3 agents working…" }),
    ).toBeVisible();
    act(() => f.observe("turn_completed", "multi-2", {}, agents[2]));
    expect(
      screen.getByRole("button", { name: "View thread: 2 agents working…" }),
    ).toBeVisible();
    act(() =>
      agents.slice(0, 2).forEach((agent, i) => {
        f.observe("turn_completed", `multi-${i}`, {}, agent);
      }),
    );
    view.rerender(
      <MessageRow
        {...props}
        row={{ ...f.first, replyCount: 8, participants: agents }}
      />,
    );
    const complete = screen.getByRole("button", {
      name: "View thread",
    });
    expect(
      [...complete.querySelectorAll("[data-avatar-shape][title]")].map((node) =>
        node.getAttribute("title"),
      ),
    ).toEqual(
      agents
        .slice(0, 3)
        .reverse()
        .map((agent) => agent.slice(0, 10)),
    );
  } finally {
    cleanup();
    await f.dispose();
  }
});

it("does not settle exact working evidence on a coordination message, and clears on disconnect", async () => {
  const f = await threadThinkingFixture();
  try {
    const props = {
      session: f.session,
      profile: undefined,
      media: f.session.media,
      onOpenLink: () => false,
      onOpenThread: () => {},
      day: false,
      retry: undefined,
    };
    const view = render(<MessageRow {...props} row={f.first} />);
    act(() => f.start(f.first.id));
    const working = screen.getByRole("button", {
      name: /View thread:.*working/,
    });
    view.rerender(
      <MessageRow
        {...props}
        row={{ ...f.first, replyCount: 1, participants: [f.agent] }}
      />,
    );
    expect(working).toBeVisible();
    act(() => f.activity.state({ status: "retrying", routes: [] }));
    expect(screen.queryByRole("button", { name: /working/ })).toBeNull();
    expect(screen.getByRole("button", { name: "View thread" })).toBeVisible();
  } finally {
    cleanup();
    await f.dispose();
  }
});
