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

it("shares later hidden-handoff work and tools between the channel and live thread preview", async () => {
  const { createThreadViews, ThreadViews } = await import("./thread-views");
  const { ActivityAccessory } = await import(
    "../../bundled/agent-activity/ActivityAccessory"
  );
  const f = await threadThinkingFixture();
  await f.session.profiles.ensure([f.agent]);
  const views = createThreadViews();
  const hidden = {
    ...f.first,
    id: "e".repeat(64),
    content: "Synthetic hidden handoff",
    authorId: f.agent,
    threadRootId: f.first.id,
    audience: "agents" as const,
  };
  const owned = f.session.thread("channel", f.first.id);
  const snapshot = { ...owned.snapshot(), replies: [hidden] };
  const release = views.register(f.session, "channel", {
    ...owned,
    snapshot: () => snapshot,
  });
  const request = { message: f.first, agents: [f.agent] };
  try {
    render(
      <ThreadViews value={views}>
        <MessageRow
          session={f.session}
          row={{ ...f.first, replyCount: 4 }}
          profile={undefined}
          media={f.session.media}
          day={false}
          retry={undefined}
          onOpenLink={() => false}
          onOpenThread={() => {}}
        />
        <ActivityAccessory
          session={f.session}
          scope="test"
          channelId="channel"
          threadRootId={f.first.id}
          request={request}
          canOpen={() => false}
          open={() => false}
        />
      </ThreadViews>,
    );
    act(() => {
      f.start(f.first.id);
      f.finish(f.first.id);
    });
    expect(
      screen.queryByRole("button", { name: "Observed activity ended" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "View thread" })).toBeVisible();
    act(() => {
      f.observe("turn_started", "handoff", { triggeringEventIds: [hidden.id] });
      f.observe("acp_read", "handoff", {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "later",
            title: "buzz-dev-mcp__read_file",
            status: "in_progress",
            rawInput: { path: "later-work.ts" },
          },
        },
      });
    });
    expect(
      screen.getByRole("button", { name: "View thread: Buzzy working…" }),
    ).toBeVisible();
    const live = screen.getByRole("button", {
      name: "Reading later-work.ts",
    });
    fireEvent.click(live);
    expect(
      await screen.findByRole("button", { name: /Read file.*later-work.ts/ }),
    ).toBeVisible();
    expect(
      screen.queryByText(hidden.content, { selector: "[data-message-id] p" }),
    ).toBeNull();
    act(() => f.observe("turn_completed", "handoff"));
    expect(
      screen.queryByRole("button", { name: "Reading later-work.ts" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "View activity" })).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Buzzy" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Read file.*later-work.ts/ }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "View thread" })).toBeVisible();
  } finally {
    cleanup();
    release();
    owned.dispose();
    await f.dispose();
  }
});

it("keeps a newer accepted request waiting instead of hiding it behind an older completed turn", async () => {
  const { createThreadViews, ThreadViews } = await import("./thread-views");
  const { ActivityAccessory } = await import(
    "../../bundled/agent-activity/ActivityAccessory"
  );
  const f = await threadThinkingFixture();
  const views = createThreadViews();
  const next = {
    ...f.first,
    id: "f".repeat(64),
    threadRootId: f.first.id,
    content: "Follow-up",
    delivery: "accepted" as const,
  };
  const owned = f.session.thread("channel", f.first.id);
  const loaded = { ...owned.snapshot(), replies: [next] };
  const release = views.register(f.session, "channel", {
    ...owned,
    snapshot: () => loaded,
  });
  try {
    act(() => {
      f.start(f.first.id);
      f.finish(f.first.id);
    });
    const view = render(
      <ThreadViews value={views}>
        <ActivityAccessory
          session={f.session}
          scope="test"
          channelId="channel"
          threadRootId={f.first.id}
          request={{ message: next, agents: [f.agent] }}
          canOpen={() => false}
          open={() => false}
        />
      </ThreadViews>,
    );
    expect(
      screen.getByRole("button", {
        name: "Waiting for response…",
      }),
    ).toBeVisible();
    act(() =>
      f.observe("turn_started", "new-request", {
        triggeringEventIds: [next.id],
      }),
    );
    expect(screen.getByRole("button", { name: "Working…" })).toBeVisible();
    view.unmount();
  } finally {
    cleanup();
    release();
    owned.dispose();
    await f.dispose();
  }
});

it("keeps all participating agents and the same open thread preview after completion and request settlement", async () => {
  const { ActivityAccessory } = await import(
    "../../bundled/agent-activity/ActivityAccessory"
  );
  const { createThreadViews, ThreadViews } = await import("./thread-views");
  const f = await threadThinkingFixture();
  const peer = "c".repeat(64),
    third = "d".repeat(64);
  const views = createThreadViews();
  const owned = f.session.thread("channel", f.first.id);
  const release = views.register(f.session, "channel", owned);
  const props = {
    session: f.session,
    scope: "test",
    channelId: "channel",
    threadRootId: f.first.id,
    canOpen: () => false,
    open: () => false,
  };
  const agents = [f.agent, peer, third];
  try {
    const view = render(
      <ThreadViews value={views}>
        <ActivityAccessory {...props} request={{ message: f.first, agents }} />
      </ThreadViews>,
    );
    act(() => {
      for (const [i, agent] of agents.entries()) {
        f.observe(
          "turn_started",
          `t${i}`,
          { triggeringEventIds: [f.first.id] },
          agent,
        );
        f.observe(
          "acp_read",
          `t${i}`,
          {
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "tool_call",
                toolCallId: `tool${i}`,
                title: "buzz-dev-mcp__shell",
                status: "in_progress",
                rawInput: { command: `pnpm test agent-${i}` },
              },
            },
          },
          agent,
        );
      }
    });
    const control = screen.getByRole("button", {
      name: "Running pnpm test agent-1",
    });
    fireEvent.click(control);
    const popup = screen.getByRole("dialog");
    expect(
      await screen.findByRole("button", { name: /Run command.*agent-1/ }),
    ).toBeVisible();
    act(() =>
      agents.forEach((agent, i) => {
        f.observe("turn_completed", `t${i}`, {}, agent);
      }),
    );
    view.rerender(
      <ThreadViews value={views}>
        <ActivityAccessory {...props} />
      </ThreadViews>,
    );
    expect(
      screen.getAllByRole("button", { name: "View activity" }),
    ).toHaveLength(3);
    expect(control).toHaveTextContent("View activity");
    expect(screen.getByRole("dialog")).toBe(popup);
    expect(
      screen.getByRole("button", { name: /Run command.*agent-1/ }),
    ).toBeVisible();
  } finally {
    cleanup();
    release();
    owned.dispose();
    await f.dispose();
  }
});

it("does not apply a B-only follow-up's delivery state to retained agent A", async () => {
  const { ActivityAccessory } = await import(
    "../../bundled/agent-activity/ActivityAccessory"
  );
  const f = await threadThinkingFixture();
  const other = "c".repeat(64);
  const next = {
    ...f.first,
    id: "e".repeat(64),
    threadRootId: f.first.id,
    content: "Only B should act",
  };
  const props = {
    session: f.session,
    scope: "test",
    channelId: "channel",
    threadRootId: f.first.id,
    threadMessages: [f.first, next],
    canOpen: () => false,
    open: () => false,
  };
  try {
    act(() => {
      f.start(f.first.id);
      f.finish(f.first.id);
    });
    const tree = (delivery: "sending" | "accepted" | "failed") => (
      <ActivityAccessory
        {...props}
        request={{ message: { ...next, delivery }, agents: [other] }}
      />
    );
    const view = render(tree("sending"));
    expect(screen.getByRole("button", { name: "View activity" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Sending request…" }),
    ).toBeVisible();
    view.rerender(tree("accepted"));
    expect(screen.getByRole("button", { name: "View activity" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Waiting for response…" }),
    ).toBeVisible();
    view.rerender(tree("failed"));
    expect(screen.getByRole("button", { name: "View activity" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Request not sent" }),
    ).toBeVisible();
  } finally {
    cleanup();
    await f.dispose();
  }
});
