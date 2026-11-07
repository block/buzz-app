// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentsContext } from "../agents/react";
import type { Agents } from "../agents/service";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { TypingIndicator } from "./TypingIndicator";
import {
  claimProfileTranscript,
  profileActivityViewTarget,
} from "../profiles/target";
import {
  agent,
  other,
  root,
  secondRoot,
  fixture,
  entry,
} from "./typing-indicator-testing";
stubAvatarBrowserApis();
afterEach(cleanup);
it("stops the exact controllable request from the general popover and permits retry after failure", async () => {
  const f = fixture();
  const user = userEvent.setup();
  let rejectStop!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => {
    rejectStop = reject;
  });
  const interrupt = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValue(undefined);
  const session = {
    ...f.session,
    agentActivity: { ...f.session.agentActivity, interrupt },
  };
  f.update([], {
    local: [
      {
        scope: "test",
        agent,
        channelId: "channel",
        threadRootId: root,
        messageId: "request-to-stop",
        startedAt: 1,
        state: "working",
        stoppable: true,
      },
      {
        scope: "test",
        agent: other,
        channelId: "channel",
        threadRootId: secondRoot,
        messageId: "other-request",
        startedAt: 1,
        state: "working",
        stoppable: true,
      },
    ],
  });
  render(
    <TypingIndicator
      session={session}
      channelId="channel"
      threadRootId={root}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  const stop = screen.getByRole("button", { name: "Stop Agent" });
  expect(screen.queryByRole("button", { name: "Stop Other" })).toBeNull();
  try {
    await user.click(stop);
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(
      agent,
      "channel",
      "request-to-stop",
    );
    expect(stop).toHaveAttribute("aria-disabled", "true");
  } finally {
    await act(async () => {
      rejectStop(new Error("Try again"));
    });
  }
  await user.click(stop);
  expect(interrupt).toHaveBeenCalledTimes(2);
  f.update([entry()], { local: [] });
  expect(screen.queryByRole("button", { name: "Stop Agent" })).toBeNull();
});

it("stops hosted work in its known conversation and keeps Stop pending until the work ends", async () => {
  const f = fixture();
  const user = userEvent.setup();
  const interrupt = vi.fn(async () => true);
  const hosted = {
    subscribe: () => () => {},
    snapshot: () => undefined,
    interruptible: () => true,
    interrupt,
  } as unknown as Agents;
  f.update([], {
    turns: [
      {
        agent,
        channelId: "channel",
        turnId: "turn",
        state: "working",
        timestamp: 100,
      },
    ],
    records: [
      {
        id: "record",
        agent,
        channelIds: ["channel"],
        createdAt: 1,
        receivedAt: 100,
        kind: "turn_started",
        plaintext: JSON.stringify({
          kind: "turn_started",
          channelId: "channel",
          turnId: "turn",
          seq: 0,
          timestamp: "2026-10-29T12:00:00Z",
          payload: { threadRootEventId: root },
        }),
      },
    ],
  });
  render(
    <AgentsContext.Provider value={hosted}>
      <TypingIndicator session={f.session} channelId="channel" />
    </AgentsContext.Provider>,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  const stop = screen.getByRole("button", {
    name: "Stop Agent in Thread · First task",
  });
  await user.click(stop);
  expect(interrupt).toHaveBeenCalledExactlyOnceWith(agent, {
    channelId: "channel",
    threadRootId: root,
  });
  expect(stop).toHaveAttribute("aria-disabled", "true");
  f.update([entry()], { turns: [], records: [] });
  expect(
    screen.queryByRole("button", { name: "Stop Agent in Thread · First task" }),
  ).toBeNull();
});

it("identifies each hosted thread and stops only the selected work", async () => {
  const f = fixture();
  const user = userEvent.setup();
  const interrupt = vi.fn(async () => true);
  const hosted = {
    subscribe: () => () => {},
    snapshot: () => undefined,
    interruptible: () => true,
    interrupt,
  } as unknown as Agents;
  const tasks = [
    { root, title: "First task", file: "first.txt" },
    { root: secondRoot, title: "Second task", file: "second.txt" },
  ];
  f.update([], {
    turns: tasks.map((task) => ({
      agent,
      channelId: "channel",
      turnId: task.root,
      state: "working",
      timestamp: 100,
    })),
    records: tasks.flatMap((task) =>
      [
        { kind: "turn_started", payload: { threadRootEventId: task.root } },
        {
          kind: "acp_read",
          payload: {
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "tool_call",
                toolCallId: task.file,
                title: "Read file",
                kind: "read",
                status: "in_progress",
                locations: [{ path: task.file }],
              },
            },
          },
        },
      ].map((event, index) => ({
        id: task.root + index,
        agent,
        channelIds: ["channel"],
        createdAt: 1,
        receivedAt: 100,
        kind: event.kind,
        plaintext: JSON.stringify({
          ...event,
          channelId: "channel",
          turnId: task.root,
          seq: index,
          timestamp: "2026-10-29T12:00:00Z",
        }),
      })),
    ),
  });
  render(
    <AgentsContext.Provider value={hosted}>
      <TypingIndicator
        session={f.session}
        channelId="channel"
        openActivity={() => true}
      />
    </AgentsContext.Provider>,
  );
  await user.click(screen.getByRole("button", { name: "Running 2 tools" }));
  const rows = screen.getAllByRole("button", { name: "Open thread for Agent" });
  for (const [index, task] of tasks.entries()) {
    expect(rows[index]).toHaveTextContent("Thread · " + task.title);
    expect(rows[index]).toHaveTextContent("Reading " + task.file);
    expect(rows[index]).not.toHaveTextContent(
      index === 0 ? "Second task" : "First task",
    );
    await user.click(
      screen.getByRole("button", {
        name: "Stop Agent in Thread · " + task.title,
      }),
    );
    expect(interrupt).toHaveBeenNthCalledWith(index + 1, agent, {
      channelId: "channel",
      threadRootId: task.root,
    });
  }
});

it("shows one Solo conversation row while a follow-up waits in the same agent session", async () => {
  const f = fixture();
  const user = userEvent.setup();
  const interrupt = vi.fn(async () => undefined);
  const session = {
    ...f.session,
    agentActivity: { ...f.session.agentActivity, interrupt },
  };
  const local = [
    {
      scope: "test",
      agent,
      channelId: "channel",
      threadRootId: root,
      messageId: "first",
      startedAt: 1,
      state: "working" as const,
      soloChat: true as const,
      stoppable: true as const,
      step: { tool: "Read", target: "first.txt" },
    },
    {
      scope: "test",
      agent,
      channelId: "channel",
      threadRootId: secondRoot,
      messageId: "follow-up",
      startedAt: 2,
      state: "working" as const,
      soloChat: true as const,
      stoppable: true as const,
    },
  ];
  f.update([], { local });
  render(<TypingIndicator session={session} channelId="channel" />);
  await user.click(screen.getByRole("button", { name: "Reading first.txt" }));
  expect(screen.getAllByRole("button", { name: /^Stop Agent/ })).toHaveLength(
    1,
  );
  expect(screen.queryByText(/Thread ·/)).toBeNull();
  // Actual thread work remains separate even in a Solo channel.
  f.update([], { local: local.map((work) => ({ ...work, thread: true })) });
  expect(screen.getAllByRole("button", { name: /^Stop Agent/ })).toHaveLength(
    2,
  );
  f.update([], { local });
  await user.click(screen.getByRole("button", { name: "Stop Agent" }));
  expect(interrupt).toHaveBeenCalledExactlyOnceWith(agent, "channel", "first");
});

it("keeps Stop for a stoppable Solo follow-up when older work cannot stop", async () => {
  const f = fixture();
  const user = userEvent.setup();
  const interrupt = vi.fn(async () => undefined);
  f.update([], {
    local: [
      {
        scope: "test",
        agent,
        channelId: "channel",
        threadRootId: root,
        messageId: "older",
        startedAt: 1,
        state: "working",
        soloChat: true,
        step: { tool: "Read", target: "first.txt" },
      },
      {
        scope: "test",
        agent,
        channelId: "channel",
        threadRootId: secondRoot,
        messageId: "stoppable",
        startedAt: 2,
        state: "working",
        soloChat: true,
        stoppable: true,
      },
    ],
  });
  render(
    <TypingIndicator
      session={{
        ...f.session,
        agentActivity: { ...f.session.agentActivity, interrupt },
      }}
      channelId="channel"
    />,
  );
  await user.click(screen.getByRole("button", { name: "Reading first.txt" }));
  await user.click(screen.getByRole("button", { name: "Stop Agent" }));
  expect(interrupt).toHaveBeenCalledExactlyOnceWith(
    agent,
    "channel",
    "stoppable",
  );
});

it.each([
  { stoppable: true, profileActivity: false },
  { stoppable: false, profileActivity: false },
  { stoppable: true, profileActivity: true },
  { stoppable: false, profileActivity: true },
])(
  "opens the Solo conversation when the same agent also works in a thread (stoppable: $stoppable, profile activity: $profileActivity)",
  async ({ stoppable, profileActivity }) => {
    const f = fixture();
    const user = userEvent.setup();
    const openActivity = vi.fn(() => true);
    f.update([], {
      local: [
        {
          scope: "test",
          agent,
          channelId: "channel",
          threadRootId: root,
          messageId: "solo",
          startedAt: 1,
          state: "working",
          soloChat: true,
          ...(stoppable ? { stoppable: true as const } : {}),
          step: { tool: "Read", target: "first.txt" },
        },
        {
          scope: "test",
          agent,
          channelId: "channel",
          threadRootId: secondRoot,
          messageId: "thread",
          startedAt: 2,
          state: "working",
          soloChat: true,
          thread: true,
          ...(stoppable ? { stoppable: true as const } : {}),
        },
      ],
    });
    render(
      <TypingIndicator
        session={f.session}
        channelId="channel"
        openActivity={openActivity}
        canOpenActivity={profileActivity ? () => true : undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Reading first.txt" }));
    if (stoppable) {
      expect(screen.queryByText(/Channel conversation \/ Thread/)).toBeNull();
      expect(screen.getByText("Channel conversation")).toBeVisible();
    }
    const [row] = screen.getAllByRole("button", {
      name: profileActivity
        ? "View Agent activity"
        : "Open conversation for Agent",
    });
    if (!row) throw new Error("Missing Activity row");
    await user.click(row);
    expect(openActivity).toHaveBeenCalledWith(
      profileActivity
        ? profileActivityViewTarget(agent)
        : "buzz://channel/channel",
      undefined,
    );
    if (profileActivity)
      expect(
        claimProfileTranscript(profileActivityViewTarget(agent) ?? "") !==
          undefined,
      ).toBe(stoppable);
  },
);

it.each([false, true])(
  "keeps a Solo request in its observed reply thread (profile activity: %s)",
  async (profileActivity) => {
    const f = fixture();
    const user = userEvent.setup();
    const openActivity = vi.fn();
    f.update([], {
      local: [
        {
          scope: "test",
          agent,
          channelId: "channel",
          threadRootId: root,
          messageId: root,
          startedAt: 1,
          state: "working",
          soloChat: true,
          stoppable: true,
        },
      ],
    });
    render(
      <TypingIndicator
        session={f.session}
        channelId="channel"
        threadRootId={root}
        openActivity={openActivity}
        canOpenActivity={profileActivity ? () => true : undefined}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Activity: Agent working" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: profileActivity ? "View Agent activity" : "Open thread for Agent",
      }),
    );
    expect(openActivity).toHaveBeenCalledWith(
      profileActivity
        ? expect.any(String)
        : `buzz://message?channel=channel&id=${root}&thread=${root}`,
      profileActivity ? { rootId: root } : undefined,
    );
  },
);
