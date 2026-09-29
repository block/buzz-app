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
            sessionId: "S",
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
it("renders one request header without unlinked answer decorations/tail messages; retains popup and multiple agents after completion", async () => {
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
    const options = screen.getAllByRole("tab");
    await user.click(options[1] as HTMLElement);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).not.toBe(options[1]?.textContent);
  } finally {
    view.unmount();
    f.dispose();
  }
});

function reportedReply(
  f: ReturnType<typeof fixture>,
  agent: string,
  id: string,
  turnId = agent,
  requestId = root,
) {
  f.send(agent, turnId, 1, "turn_started", { triggeringEventIds: [requestId] });
  f.send(agent, turnId, 2, "acp_read", {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "send",
        title: "buzz-dev-mcp__shell",
        status: "in_progress",
        rawInput: { command: "buzz messages send --audience everyone" },
      },
    },
  });
  f.send(agent, turnId, 3, "acp_read", {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "send",
        status: "completed",
        rawOutput: { isError: false },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: JSON.stringify({
                exit_code: 0,
                timed_out: false,
                stdout_truncated: false,
                stdout: JSON.stringify({
                  accepted: true,
                  event_id: id,
                  message: "",
                  mention_pubkeys: [],
                  audience: "everyone",
                }),
              }),
            },
          },
        ],
      },
    },
  });
  f.send(agent, turnId, 4, "turn_completed");
}
it("attaches each agent's request work to its own real reply; tabs preserve selection on panel expansion", async () => {
  const f = fixture();
  const answers = [A, B].map((key, index) => ({
    ...row(String(index + 3).repeat(64)),
    authorId: key,
    replyParentId: root,
    audience: "everyone" as const,
  }));
  for (const answer of answers) reportedReply(f, answer.authorId, answer.id);
  const props = { ...f.props, threadMessages: [row(), ...answers] };
  const view = render(
    <>
      <ActivityAccessory {...props} />
      {answers.map((message) => (
        <div key={message.id} data-testid={message.authorId}>
          <ActivityAccessory
            {...props}
            workRequest={undefined}
            message={message}
          />
        </div>
      ))}
    </>,
  );
  try {
    expect(
      screen.queryByRole("region", { name: "Work linked to this request" }),
    ).toBeNull();
    expect(
      screen.getAllByRole("region", { name: "Agent work on this request" }),
    ).toHaveLength(2);
    fireEvent.click(
      within(screen.getByTestId(B)).getByRole("button", { name: /Worked/ }),
    );
    expect(screen.getByRole("tab", { name: "Bubbles" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    vi.useRealTimers();
    await userEvent.setup().click(screen.getByRole("tab", { name: "Blossom" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open activity in panel" }),
    );
    expect(f.props.open).toHaveBeenCalledWith(
      expect.stringContaining(`agent=${A}`),
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("combines a single direct answer without repeated avatar and keeps fallback access for collapsed nested answers", () => {
  const f = fixture();
  const request = { ...row(), mentions: [A] },
    answer = { ...row("3".repeat(64)), authorId: A, replyParentId: root };
  reportedReply(f, A, answer.id);
  const props = {
    ...f.props,
    workRequest: request,
    threadMessages: [request, answer],
  };
  const view = render(
    <>
      <ActivityAccessory {...props} />
      <ActivityAccessory {...props} workRequest={undefined} message={answer} />
    </>,
  );
  try {
    expect(
      screen.queryByRole("region", { name: "Work linked to this request" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("region", { name: "Agent work on this request" })
        .querySelector(".buzz-avatar"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Worked/ }));
    expect(screen.queryByRole("tablist")).toBeNull();
    const nested = { ...answer, replyParentId: next };
    view.rerender(
      <ActivityAccessory
        {...props}
        threadMessages={[request, row(next), nested]}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Work linked to this request" }),
    ).toBeVisible();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("keeps an open shared popup stable as all direct replies arrive, then removes the redundant header on close", () => {
  const f = fixture(),
    request = { ...row(), mentions: [A] };
  const view = render(
    <ActivityAccessory
      {...f.props}
      workRequest={request}
      threadMessages={[request]}
    />,
  );
  try {
    fireEvent.click(screen.getByRole("button", { name: /awaiting activity/ }));
    const popup = screen.getByRole("dialog");
    const answer = { ...row("3".repeat(64)), authorId: A, replyParentId: root };
    reportedReply(f, A, answer.id);
    view.rerender(
      <ActivityAccessory
        {...f.props}
        workRequest={request}
        threadMessages={[request, answer]}
      />,
    );
    expect(screen.getByRole("dialog")).toBe(popup);
    expect(
      screen.getByRole("button", { name: /Blossom worked/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close activity" }));
    expect(
      screen.queryByRole("region", { name: "Work linked to this request" }),
    ).toBeNull();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("keeps activity on each exact reply when an earlier blocker precedes an answer; nested, hidden and follow-up work stay scoped", () => {
  const f = fixture();
  const request = { ...row(), mentions: [A] };
  const blocker = {
    ...row("3".repeat(64)),
    authorId: A,
    replyParentId: next,
    content: "Synthetic blocker",
  };
  const answer = {
    ...row("4".repeat(64)),
    authorId: A,
    replyParentId: root,
    audience: "everyone" as const,
    content: "Synthetic answer",
  };
  const hidden = {
    ...row("5".repeat(64)),
    authorId: A,
    replyParentId: root,
    audience: "agents" as const,
  };
  const unreported = {
    ...row("6".repeat(64)),
    authorId: A,
    replyParentId: root,
  };
  const followup = { ...row("7".repeat(64)), authorId: A, replyParentId: next };
  reportedReply(f, A, blocker.id, "blocker");
  const content = (replies: ChannelMessage[]) => (
    <>
      <ActivityAccessory
        {...f.props}
        workRequest={request}
        threadMessages={[request, row(next), ...replies]}
      />
      {replies.map((message) => (
        <div key={message.id} data-testid={message.id}>
          <ActivityAccessory
            {...f.props}
            workRequest={undefined}
            threadMessages={[request, row(next), ...replies]}
            message={message}
          />
        </div>
      ))}
    </>
  );
  const view = render(content([blocker]), { reactStrictMode: true });
  try {
    expect(
      screen.getByRole("region", { name: "Work linked to this request" }),
    ).toBeVisible();
    fireEvent.click(within(screen.getByTestId(blocker.id)).getByRole("button"));
    const popup = screen.getByRole("dialog");
    reportedReply(f, A, answer.id, "answer");
    reportedReply(f, A, hidden.id, "handoff");
    reportedReply(f, A, followup.id, "followup", next);
    view.rerender(content([blocker, answer, hidden, unreported, followup]));
    expect(screen.getByRole("dialog")).toBe(popup);
    expect(
      screen.queryByRole("region", { name: "Work linked to this request" }),
    ).toBeNull();
    for (const reply of [blocker, answer, followup])
      expect(
        within(screen.getByTestId(reply.id)).getByRole("region", {
          name: "Agent work on this request",
        }),
      ).toBeInTheDocument();
    for (const reply of [hidden, unreported])
      expect(
        within(screen.getByTestId(reply.id)).queryByRole("region"),
      ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close activity" }));
    for (const [reply, requestId] of [
      [answer, root],
      [followup, next],
    ] as const) {
      fireEvent.click(within(screen.getByTestId(reply.id)).getByRole("button"));
      fireEvent.click(
        screen.getByRole("button", { name: "Open activity in panel" }),
      );
      expect(f.props.open).toHaveBeenLastCalledWith(
        expect.stringContaining(`request=${requestId}&thread=${root}`),
      );
    }
  } finally {
    view.unmount();
    f.dispose();
  }
});
