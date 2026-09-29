// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ActivityAccessory } from "./ActivityAccessory";
import { createAgentActivity } from "../../features/agents/activity";
import { createAgentLibrary } from "../../features/agents/library";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelMessage } from "../../features/relay/contracts";
import { stubPopoverBrowserApis } from "./popover-testing";
stubPopoverBrowserApis();
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const A = "b".repeat(64),
  B = "c".repeat(64),
  viewer = "a".repeat(64),
  root = "1".repeat(64),
  next = "2".repeat(64);
const row = (id = root): ChannelMessage => ({
  id,
  authorId: viewer,
  channelId: "c",
  createdAt: 1,
  content: "Synthetic request",
  mentions: [A, B],
  participants: [],
  replyCount: 0,
  attachments: [],
  reactions: [],
  ...(id !== root ? { threadRootId: root } : {}),
});
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  let generation = 0,
    serial = 0;
  const activity = createAgentActivity(
    true,
    (g) => {
      generation = g ?? 0;
    },
    () => true,
  );
  const release = activity.queries.activate();
  const live = {
    status: "connected" as const,
    routes: [
      { id: "observer", status: "live" as const, replay: "unknown" as const },
    ],
  };
  activity.state(live);
  const profiles = new Map([
    [A, { name: "Blossom", isAgent: true }],
    [B, { name: "Bubbles", isAgent: true }],
  ]);
  const session = {
    viewer,
    agentActivity: activity.queries,
    agentChoices: createAgentLibrary(undefined).queries,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
    },
    live: { retry: () => activity.state(live) },
    media: () => undefined,
  } as unknown as RelaySession;
  const send = (
    agent: string,
    turnId: string,
    seq: number,
    kind: string,
    payload: unknown = {},
  ) =>
    act(() => {
      activity.receive(
        {
          id: (++serial).toString(16).padStart(64, "0"),
          agent,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            kind,
            turnId,
            channelId: "c",
            seq,
            timestamp: new Date().toISOString(),
            payload,
          }),
        },
        generation,
      );
    });
  const open = vi.fn(() => true);
  const props = {
    session,
    scope: "test",
    channelId: "c",
    threadRootId: root,
    workRequest: row(),
    threadMessages: [row(), row(next)],
    threadComplete: true,
    canOpen: () => true,
    open,
  };
  return {
    activity,
    release,
    send,
    props,
    live,
    profiles,
    dispose: () => {
      release();
      activity.dispose();
    },
  };
}
it("renders one request header, never answer decorations/tail messages; retains popup and multiple agents after completion", async () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />, {
    reactStrictMode: true,
  });
  try {
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: "Blossom and Bubbles · awaiting activity",
      }),
    ).toBeVisible();
    f.send(A, "A", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "B", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(A, "A", 2, "acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "calc",
          title: "buzz-dev-mcp__shell",
          status: "completed",
          rawInput: { command: "python3 check.py" },
          rawOutput: "42",
        },
      },
    });
    const control = screen.getByRole("button", {
      name: "Blossom and Bubbles are working…",
    });
    fireEvent.click(control);
    const popup = screen.getByRole("dialog", { name: "Request activity" });
    expect(
      within(popup).getByRole("button", {
        name: "Run command · python3 check.py",
      }),
    ).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(240000));
    f.send(A, "A", 3, "turn_completed");
    f.send(B, "B", 2, "turn_completed");
    expect(
      screen.getByRole("button", {
        name: "Blossom and Bubbles worked for 4 minutes",
      }),
    ).toBe(control);
    expect(screen.getByRole("dialog")).toBe(popup);
    fireEvent.click(
      within(popup).getByRole("button", {
        name: "Run command · python3 check.py",
      }),
    );
    expect(screen.getByText('"42"')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open activity in panel" }),
    );
    expect(f.props.open).toHaveBeenCalledWith(
      expect.stringContaining(`request=${root}&thread=${root}`),
    );
    view.rerender(
      <ActivityAccessory {...f.props} message={{ ...row(), authorId: A }} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<ActivityAccessory {...f.props} workRequest={undefined} />);
    expect(screen.queryByRole("button")).toBeNull();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("names only currently working agents and keeps errors/unknown distinct without durations", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "A", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "B", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "B", 2, "turn_completed");
    expect(
      screen.getByRole("button", { name: "Blossom is working…" }),
    ).toBeVisible();
    f.send(A, "A", 2, "turn_error", { error: "Synthetic failure" });
    fireEvent.click(
      screen.getByRole("button", { name: "Blossom · error reported" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Diagnostics.*Error reported/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Turn error" }));
    expect(screen.getByText("Synthetic failure")).toBeInTheDocument();
    act(() => f.activity.clear());
    expect(
      screen.getByRole("button", {
        name: "Blossom and Bubbles · work status unknown",
      }),
    ).toBeVisible();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("does not mix a second request or failed delivery with earlier work", () => {
  const f = fixture();
  const view = render(
    <>
      <ActivityAccessory {...f.props} />
      <ActivityAccessory {...f.props} workRequest={row(next)} />
    </>,
  );
  try {
    f.send(A, "A", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(A, "A", 2, "turn_completed");
    f.send(B, "B", 1, "turn_started", { triggeringEventIds: [next] });
    expect(
      screen.getByRole("button", { name: /Blossom worked/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Bubbles is working…" }),
    ).toBeVisible();
    view.rerender(
      <ActivityAccessory
        {...f.props}
        workRequest={{ ...row(next), delivery: "failed" }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Request not sent" }),
    ).toBeVisible();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("keeps namesake exact identities selectable and scope-completeness fences duration", async () => {
  const f = fixture();
  f.profiles.set(B, { name: "Blossom", isAgent: true });
  const view = render(
    <ActivityAccessory {...f.props} threadComplete={false} />,
  );
  try {
    f.send(A, "A", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "B", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(A, "A", 2, "turn_completed");
    f.send(B, "B", 2, "turn_completed");
    const header = screen.getByRole("button", {
      name: /worked on this request/,
    });
    expect(header.textContent).toContain("npub");
    fireEvent.click(header);
    vi.useRealTimers();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Agent" }));
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).not.toBe(options[1]?.textContent);
  } finally {
    view.unmount();
    f.dispose();
  }
});
