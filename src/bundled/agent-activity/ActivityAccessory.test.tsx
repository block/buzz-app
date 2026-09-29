// @vitest-environment jsdom
import { stubPopoverBrowserApis } from "./popover-testing";
stubPopoverBrowserApis();
import userEvent from "@testing-library/user-event";
import { activityTarget } from "../../features/agents/activity-target";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  createAgentActivity,
  ACTIVITY_FRESH_MS,
} from "../../features/agents/activity";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelMessage } from "../../features/relay/contracts";
import { ThreadActivityContext } from "../../features/messages/ThreadActivityContext";
import { ActivityAccessory } from "./ActivityAccessory";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const agent = "a".repeat(64),
  root = "b".repeat(64),
  nested = "c".repeat(64);
function setup() {
  let generation = 0,
    seq = 0;
  const service = createAgentActivity(
    true,
    (next) => {
      generation = next ?? 0;
    },
    () => true,
  );
  const release = service.queries.activate();
  service.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  const profiles = new Map([[agent, { name: "Rivet" }]]);
  const session = {
    agentActivity: service.queries,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
    },
    media: (url: string) => url,
  } as unknown as RelaySession;
  const props = {
    session,
    scope: "scope",
    channelId: "alpha",
    threadRootId: root,
    canOpen: () => true,
    open: () => true,
  };
  function send(
    kind: string,
    payload: unknown = {},
    turnId = "ours",
    author = agent,
    channelId = "alpha",
  ) {
    act(() =>
      service.receive(
        {
          id: `${++seq}`.padStart(64, "0"),
          agent: author,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            kind,
            channelId,
            turnId,
            seq,
            timestamp: new Date().toISOString(),
            payload,
          }),
        },
        generation,
      ),
    );
  }
  function typing(thread = root, author = agent) {
    act(() =>
      service.channelEvents([
        {
          id: `typing-${seq++}`,
          kind: 20002,
          pubkey: author,
          content: "",
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["h", "alpha"],
            ["e", thread, "", "reply"],
          ],
        },
      ]),
    );
  }
  const stop = () => {
    release();
    service.dispose();
  };
  return { service, session, props, send, typing, stop };
}
const tool = (
  name = "buzz-dev-mcp__read_file",
  rawInput: Record<string, string> = { path: "/project/tokens.css" },
  status = "in_progress",
) => ({
  method: "session/update",
  params: {
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool",
      title: name,
      rawInput,
      status,
    },
  },
});
it("starts from exact-thread typing, never shows pending intent as work, and removes settled message chrome", () => {
  const f = setup();
  const request = {
    message: { id: root, delivery: "seen" } as ChannelMessage,
    agents: [agent],
  };
  const view = render(<ActivityAccessory {...f.props} request={request} />);
  try {
    expect(screen.queryByRole("button")).toBeNull();
    f.send("agent_initialized");
    f.typing("d".repeat(64));
    expect(screen.queryByRole("button")).toBeNull();
    f.typing();
    expect(screen.getByRole("button", { name: "Rivet Working…" })).toBeTruthy();
    view.rerender(
      <ActivityAccessory
        {...f.props}
        message={{ authorId: agent } as ChannelMessage}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<ActivityAccessory {...f.props} threadRootId={undefined} />);
    expect(screen.queryByRole("button")).toBeNull();
  } finally {
    view.unmount();
    f.stop();
  }
});
it("updates one line, excludes other threads and removes it at the terminal even with delayed typing", () => {
  const f = setup();
  const view = render(<ActivityAccessory {...f.props} />, {
    reactStrictMode: true,
  });
  try {
    f.send(
      "turn_started",
      { triggeringEventIds: ["d".repeat(64)] },
      "elsewhere",
    );
    f.send("acp_read", tool(), "elsewhere");
    expect(screen.queryByRole("button")).toBeNull();
    f.send("turn_started", { triggeringEventIds: [root] });
    expect(screen.getByRole("button", { name: "Rivet Working…" })).toBeTruthy();
    f.send("acp_read", tool());
    const line = screen.getByRole("button", {
      name: "Rivet Reading tokens.css",
    });
    expect(
      screen.getByRole("button", { name: "Rivet Reading tokens.css" }),
    ).toBe(line);
    f.send("acp_read", {
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update" } },
    });
    expect(
      screen.getByRole("button", { name: "Rivet Reading tokens.css" }),
    ).toBe(line);
    f.send("acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "A reply should not be another row" },
        },
      },
    });
    fireEvent.click(line);
    expect(screen.queryByText("A reply should not be another row")).toBeNull();
    expect(screen.queryByText("Usage update")).toBeNull();
    f.typing();
    f.send("turn_completed");
    expect(
      screen.queryByRole("region", { name: "Agent activity in this thread" }),
    ).toBeNull();
  } finally {
    view.unmount();
    f.stop();
  }
});
it("keeps explicitly linked nested work after pending intent disappears, and never mixes agents", () => {
  const f = setup();
  const other = "e".repeat(64);
  const view = render(
    <ThreadActivityContext value={[root, nested]}>
      <ActivityAccessory {...f.props} />
    </ThreadActivityContext>,
  );
  try {
    f.send("turn_started", { triggeringEventIds: [nested] });
    f.send("acp_read", tool());
    f.send("turn_started", { triggeringEventIds: [root] }, "other", other);
    f.send("acp_read", tool(), "other", other);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Rivet Reading tokens.css" }),
    ).toBeTruthy();
    f.send("turn_completed");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    f.send("turn_completed", {}, "other", other);
    expect(screen.queryByRole("button")).toBeNull();
  } finally {
    view.unmount();
    f.stop();
  }
});
it("shows uncertainty on freshness expiry and clears all private work on reset", () => {
  vi.useFakeTimers();
  const f = setup();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send("turn_started", { triggeringEventIds: [root] });
    f.send("acp_read", tool());
    act(() => vi.advanceTimersByTime(ACTIVITY_FRESH_MS + 1000));
    expect(
      screen.getByRole("button", { name: /details may be out of date/ }),
    ).toBeTruthy();
    f.send("turn_liveness");
    expect(
      screen.getByRole("button", { name: "Rivet Reading tokens.css" }),
    ).toBeTruthy();
    act(() => f.service.clear());
    expect(screen.queryByRole("button")).toBeNull();
  } finally {
    view.unmount();
    f.stop();
  }
});

it("accepts a new turn's typing after the prior terminal without reviving its details", () => {
  vi.useFakeTimers();
  const f = setup();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send("turn_started", { triggeringEventIds: [root] });
    f.send("acp_read", tool());
    f.send("turn_completed");
    expect(screen.queryByRole("button")).toBeNull();
    act(() => vi.advanceTimersByTime(2000));
    f.typing();
    expect(screen.getByRole("button", { name: "Rivet Working…" })).toBeTruthy();
    expect(screen.queryByText(/tokens.css/)).toBeNull();
  } finally {
    view.unmount();
    f.stop();
  }
});

it("does not turn an unknown old action into current work when new typing arrives", () => {
  vi.useFakeTimers();
  const f = setup();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send("turn_started", { triggeringEventIds: [root] });
    f.send("acp_read", tool());
    act(() => vi.advanceTimersByTime(ACTIVITY_FRESH_MS + 1000));
    f.typing();
    expect(screen.getByRole("button", { name: "Rivet Working…" })).toBeTruthy();
    expect(screen.queryByText(/tokens.css/)).toBeNull();
  } finally {
    view.unmount();
    f.stop();
  }
});

it("renders permission targets and reported failures without raw protocol rows", () => {
  const f = setup();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send("turn_started", { triggeringEventIds: [root] });
    f.send("acp_read", {
      id: "permission",
      method: "session/request_permission",
      params: {
        toolCall: { title: "Read design tokens" },
        options: [{ optionId: "yes", kind: "allow_once" }],
      },
    });
    expect(
      screen.getByRole("button", {
        name: "Rivet Permission requested · Read design tokens",
      }),
    ).toBeTruthy();
    f.send("acp_write", {
      id: "permission",
      result: { outcome: { outcome: "selected", optionId: "yes" } },
    });
    f.send("acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "failed",
          title: "lookup",
          rawInput: { query: "design tokens" },
          status: "failed",
          rawOutput: "Access denied",
        },
      },
    });
    const failed = screen.getByRole("button", {
      name: /Rivet Using lookup design tokens failed · .*Access denied/,
    });
    fireEvent.click(failed);
    expect(screen.queryByText("Permission allowed")).toBeNull();
    expect(screen.queryByText("Other activity")).toBeNull();
  } finally {
    view.unmount();
    f.stop();
  }
});

it("retains completed and posting actions without clearing another agent before turn end", () => {
  const f = setup();
  const other = "e".repeat(64);
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send("turn_started", { triggeringEventIds: [root] });
    f.send("acp_read", tool());
    f.send("turn_started", { triggeringEventIds: [root] }, "other", other);
    f.send("acp_read", tool(), "other", other);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    f.send(
      "acp_read",
      tool(
        "buzz-dev-mcp__read_file",
        { path: "/project/tokens.css" },
        "completed",
      ),
    );
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Rivet Read tokens.css" }),
    ).toBeTruthy();
    const next = tool("buzz-dev-mcp__shell", {
      command: "buzz messages send --content 'Done'",
    });
    next.params.update.toolCallId = "post";
    f.send("acp_read", next);
    f.typing();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Rivet Running buzz messages send" }),
    ).toBeTruthy();
    f.send("acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "post",
          status: "completed",
        },
      },
    });
    expect(
      f.service.queries.snapshot().turns.find((turn) => turn.turnId === "ours")
        ?.state,
    ).toBe("working");
    expect(
      f.service.queries
        .snapshot()
        .typing.some((entry) => entry.agent === agent),
    ).toBe(true);
    const continued = tool("buzz-dev-mcp__read_file", {
      path: "/project/follow-up.ts",
    });
    continued.params.update.toolCallId = "continued";
    f.send("acp_read", continued);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Rivet Reading follow-up.ts" }),
    ).toBeTruthy();
    f.send("turn_completed");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  } finally {
    view.unmount();
    f.stop();
  }
});

it("shows a fast read whose start and completion arrive in one batch", () => {
  const f = setup();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send("turn_started", { triggeringEventIds: [root] });
    f.send("batch", {
      events: [
        { kind: "acp_read", payload: tool(), seq: 2 },
        {
          kind: "acp_read",
          payload: {
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tool",
                status: "completed",
              },
            },
          },
          seq: 3,
        },
      ].map((event) => ({
        ...event,
        channelId: "alpha",
        turnId: "ours",
        timestamp: new Date().toISOString(),
      })),
    });
    expect(
      screen.getByRole("button", { name: "Rivet Read tokens.css" }),
    ).toBeTruthy();
    f.send("turn_completed");
    expect(screen.queryByRole("button")).toBeNull();
  } finally {
    view.unmount();
    f.stop();
  }
});

it("shimmers only the live action, stopping on disconnect, staleness and completion", () => {
  vi.useFakeTimers();
  const f = setup();
  const view = render(<ActivityAccessory {...f.props} />);
  const active = () =>
    view.container.querySelector(".buzz-shimmer[data-active]");
  try {
    f.send("agent_initialized");
    f.typing();
    expect(active()?.textContent).toBe("Working…");
    expect(screen.getByText("Rivet").closest(".buzz-shimmer")).toBeNull();
    f.send("turn_started", { triggeringEventIds: [root] });
    f.send("acp_read", tool());
    expect(active()?.textContent).toBe("Reading tokens.css");
    act(() => f.service.state({ status: "retrying", routes: [] }));
    expect(active()).toBeNull();
    act(() =>
      f.service.state({
        status: "connected",
        routes: [{ id: "observer", status: "live", replay: "unknown" }],
      }),
    );
    f.send("turn_liveness");
    expect(active()?.textContent).toBe("Reading tokens.css");
    act(() => vi.advanceTimersByTime(ACTIVITY_FRESH_MS + 1000));
    expect(active()).toBeNull();
    expect(
      screen.getByRole("button", { name: /details may be out of date/ }),
    ).toBeTruthy();
    f.send("turn_liveness");
    expect(active()).not.toBeNull();
    f.send("turn_completed");
    expect(view.container.querySelector(".buzz-shimmer")).toBeNull();
  } finally {
    view.unmount();
    f.stop();
  }
});

it("opens the selected agent's channel activity panel from the popover", async () => {
  const user = userEvent.setup();
  const f = setup();
  const open = vi.fn(() => true);
  const view = render(<ActivityAccessory {...f.props} open={open} />);
  try {
    f.send("turn_started", { triggeringEventIds: [root] });
    await user.click(screen.getByRole("button", { name: "Rivet Working…" }));
    expect(screen.getByRole("dialog", { name: "Rivet" })).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Open activity in panel" }),
    );
    expect(open).toHaveBeenCalledWith(activityTarget(agent, "alpha"));
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    view.unmount();
    f.stop();
  }
});

it("keeps the popover open if the host cannot open the activity panel", async () => {
  const user = userEvent.setup();
  const f = setup();
  const view = render(<ActivityAccessory {...f.props} open={() => false} />);
  try {
    f.send("turn_started", { triggeringEventIds: [root] });
    await user.click(screen.getByRole("button", { name: "Rivet Working…" }));
    await user.click(
      screen.getByRole("button", { name: "Open activity in panel" }),
    );
    expect(screen.getByRole("dialog", { name: "Rivet" })).toBeTruthy();
  } finally {
    view.unmount();
    f.stop();
  }
});

it("retires the live row when its sent reply is visible, without ending the turn or hiding another agent", () => {
  const f = setup();
  const reply = "d".repeat(64);
  const other = "e".repeat(64);
  const renderActivity = (ids: string[]) => (
    <ThreadActivityContext value={ids}>
      <ActivityAccessory {...f.props} />
    </ThreadActivityContext>
  );
  const view = render(renderActivity([root]));
  try {
    f.send("turn_started", { triggeringEventIds: [root] });
    f.send("turn_started", { triggeringEventIds: [root] }, "other", other);
    const send = tool("send_message", { content: "Done", channel_id: "alpha" });
    send.params.update.toolCallId = "post";
    f.send("acp_read", send);
    f.typing();
    f.send("acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "post",
          status: "completed",
          rawOutput: { accepted: true, event_id: reply },
        },
      },
    });
    // A tool report alone must not remove the only visible response indicator.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    view.rerender(renderActivity([root, "f".repeat(64)]));
    expect(screen.getAllByRole("button")).toHaveLength(2);
    view.rerender(renderActivity([root, reply]));
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(
      f.service.queries.snapshot().turns.find((turn) => turn.turnId === "ours")
        ?.state,
    ).toBe("working");
    f.send("acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "I sent the message." },
        },
      },
    });
    const stop = tool("buzz-dev-mcp___Stop", {}, "completed");
    stop.params.update.toolCallId = "stop";
    f.send("acp_read", stop);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    const continued = tool("buzz-dev-mcp__read_file", {
      path: "/project/follow-up.ts",
    });
    continued.params.update.toolCallId = "continued";
    f.send("acp_read", continued);
    expect(
      screen.getByRole("button", { name: "Rivet Reading follow-up.ts" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  } finally {
    view.unmount();
    f.stop();
  }
});

it.each(["failed", "concurrent"])(
  "keeps %s work visible after a message arrives",
  (scenario) => {
    const f = setup();
    const reply = "d".repeat(64);
    const view = render(
      <ThreadActivityContext value={[root, reply]}>
        <ActivityAccessory {...f.props} />
      </ThreadActivityContext>,
    );
    try {
      f.send("turn_started", { triggeringEventIds: [root] });
      if (scenario === "concurrent") f.send("acp_read", tool());
      f.send("acp_read", {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "post",
            title: "send_message",
            rawInput: { content: "Done", channel_id: "alpha" },
            status: scenario === "failed" ? "failed" : "completed",
            rawOutput: { accepted: scenario !== "failed", event_id: reply },
          },
        },
      });
      expect(screen.getByRole("button", { name: /Rivet/ })).toBeTruthy();
    } finally {
      view.unmount();
      f.stop();
    }
  },
);
