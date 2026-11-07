// @vitest-environment jsdom
import { ActivityGroupPreview } from "../../features/messages/ActivityGroupPreview";
import { activityPresentation } from "../../features/messages/activity-presentation";
import { MessageRow } from "../../features/messages/MessageRow";
import { createLocalAgentActivity } from "../../features/agents/local-activity";
import { createRelaySession } from "../../features/relay/session";
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

import { afterEach, expect, it, vi } from "vitest";
import { ActivityAccessory } from "./ActivityAccessory";
import { TypingIndicator } from "../../features/messages/TypingIndicator";
import { AgentsContext } from "../../features/agents/react";
import type { Agents } from "../../features/agents/service";
import {
  claimProfileTranscript,
  profileTranscriptRequest,
} from "../../features/profiles/target";
import { createAgentActivity } from "../../features/agents/activity";
import { createAgentLibrary } from "../../features/agents/library";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";

// Stop's results are host toasts; the shared Toast owns how they show.
const notify = vi.hoisted(() => vi.fn());
vi.mock("../../shared/design-system/ui/Toast", async (original) => ({
  ...(await original<typeof import("../../shared/design-system/ui/Toast")>()),
  useToastNotification: () => notify,
}));

afterEach(() => {
  cleanup();
  notify.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Transcript requests live in a module-level map; each test starts clean.
  for (const agent of [A, B])
    claimProfileTranscript(`buzz:profile?agent=${agent}&tab=activity`);
});
const A = "b".repeat(64),
  B = "c".repeat(64),
  viewer = "a".repeat(64),
  root = "1".repeat(64),
  next = "2".repeat(64);
function fixture(local?: ReturnType<typeof createLocalAgentActivity>) {
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
    undefined,
    undefined,
    local ? { source: local.reader, scope: "test" } : undefined,
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
    [A, { name: "Blossom", isAgent: true as const }],
    [B, { name: "Bubbles", isAgent: true as const }],
  ]);
  let rows: readonly ChannelMessage[] = [];
  const session = {
    viewer,
    presence: {
      subscribe: () => () => {},
      status: () => "online",
      limited: () => false,
    },
    agentActivity: activity.queries,
    agentChoices: createAgentLibrary(undefined).queries,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
    },
    typing: { snapshot: () => noTyping, subscribe: () => () => {} },
    // The loaded channel window, which tells the timeline's end which threads exist.
    channels: {
      window: () => ({ rows }),
      subscribeWindow: () => () => {},
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
    message: {
      id: root,
      channelId: "c",
      authorId: viewer,
      createdAt: 1,
      content: "Request",
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
    },
    canOpen: () => true,
    open,
  };
  return {
    activity,
    release,
    send,
    // A hosted turn for the request, in the conversation its harness names.
    start: (agent: string, turnId: string) =>
      send(agent, turnId, 1, "turn_started", {
        triggeringEventIds: [root],
        threadRootEventId: root,
      }),
    setRows: (next: readonly ChannelMessage[]) => {
      rows = next;
    },
    props,
    live,
    profiles,
    dispose: () => {
      release();
      activity.dispose();
    },
  };
}
const noTyping: readonly never[] = [];
type Props = ReturnType<typeof fixture>["props"] &
  Partial<Parameters<typeof ActivityAccessory>[0]>;
/** The request message's accessory and its conversation's end indicator, as a
 * thread or (with `channel`) the channel timeline mounts them. */
function Conversation({
  agents,
  channel = false,
  ...props
}: Props & { agents?: Agents; channel?: boolean }) {
  return (
    <AgentsContext.Provider value={agents}>
      <div data-testid="request">
        <ActivityAccessory {...props} />
      </div>
      <div data-testid="end">
        <TypingIndicator
          audience="agents"
          inFlow
          session={props.session}
          channelId={props.channelId}
          threadRootId={channel ? undefined : props.threadRootId}
          canOpenActivity={props.canOpen}
          openActivity={props.open}
        />
      </div>
    </AgentsContext.Provider>
  );
}
const settle = () => act(async () => {});
const request = () => within(screen.getByTestId("request"));
const end = () => within(screen.getByTestId("end"));
const endTrigger = () =>
  screen
    .getByTestId("end")
    .querySelector<HTMLButtonElement>("[data-agent-activity-trigger]");
const openOutcome = () =>
  fireEvent.click(
    (screen.queryByTestId("request") ? request() : screen).getByRole("button", {
      name: /View agent activity/,
    }),
  );
const openEnd = () => {
  const trigger = endTrigger();
  if (!trigger) throw new Error("No live work at the conversation's end");
  fireEvent.click(trigger);
};
const stopButton = () => screen.queryByRole("button", { name: "Stop Blossom" });
// Reopen the end's popup, if anything closed it, to read the agent's row.
const look = () => {
  const trigger = endTrigger();
  if (trigger && !screen.queryByRole("dialog")) fireEvent.click(trigger);
  return screen;
};
const stopPending = () =>
  expect(stopButton()).toHaveAttribute("aria-disabled", "true");
const stopReady = () =>
  expect(stopButton()).not.toHaveAttribute("aria-disabled");
function hosted(running: boolean | Promise<boolean> = true) {
  return {
    subscribe: () => () => {},
    snapshot: () => undefined,
    interruptible: vi.fn(() => true),
    interrupt: vi.fn(async () => running),
  };
}
const asAgents = (agents: ReturnType<typeof hosted>) =>
  agents as unknown as Agents;

it.each([false, true])(
  "shows live work only at the conversation's end, never on its request (channel=%s)",
  (channel) => {
    const local = createLocalAgentActivity();
    const f = fixture(local);
    const view = render(<Conversation {...f.props} channel={channel} />);
    try {
      let work!: ReturnType<typeof local.begin>;
      act(() => {
        work = local.begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        });
      });
      const expectOnlyAtEnd = () => {
        console.log(screen.getByTestId("end").innerHTML);
        expect(screen.getByTestId("request")).toBeEmptyDOMElement();
        expect(endTrigger()).toBeVisible();
        expect(
          view.container.querySelectorAll("[data-agent-activity-trigger]"),
        ).toHaveLength(1);
      };
      expectOnlyAtEnd();
      act(() => work.started());
      expectOnlyAtEnd();
      act(() => work.step("Read", "notes.txt"));
      expectOnlyAtEnd();
      expect(end().getByText("Reading notes.txt")).toBeVisible();
      // What happened to the request stays on it; the end has nothing live.
      act(() => work.finish({ ok: false, error: "Provider unavailable" }));
      expect(endTrigger()).toBeNull();
      expect(request().getByText("Couldn’t finish")).toBeVisible();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);

it.each([false, true])(
  "shows a hosted turn only at its conversation's end (channel=%s)",
  (channel) => {
    const f = fixture();
    const view = render(
      <Conversation
        {...f.props}
        channel={channel}
        messageLayout={channel ? undefined : "thread"}
      />,
    );
    try {
      f.start(A, "a");
      f.start(B, "b");
      expect(screen.getByTestId("request")).toBeEmptyDOMElement();
      expect(
        end().getByRole("button", { name: "Activity: 2 agents working" }),
      ).toBeVisible();
      f.send(A, "a", 2, "turn_completed");
      expect(
        end().getByRole("button", { name: "Activity: Bubbles working" }),
      ).toBeVisible();
      f.send(B, "b", 2, "turn_completed", { outcome: "failed" });
      expect(endTrigger()).toBeNull();
      expect(request().getByText("Couldn’t finish")).toBeVisible();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);

it("moves a top-level request's work from the channel's end into its thread once the thread exists", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<Conversation {...f.props} channel />);
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .started();
    });
    f.start(B, "b");
    expect(
      end().getByRole("button", { name: "Activity: 2 agents working" }),
    ).toBeVisible();
    // A reply makes the request a thread: its work is that thread's now, and
    // the channel shows it in the thread's reply summary instead.
    f.setRows([{ ...f.props.message, replyCount: 1 }]);
    view.rerender(<Conversation {...f.props} channel />);
    expect(endTrigger()).toBeNull();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("keeps coordination history readable but never live: no sheen and no Stop", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const stop = vi.fn(async () => {});
  const work = local.begin({
    scope: "test",
    agent: A,
    channelId: "c",
    messageId: root,
    threadRootId: root,
    thread: true,
  });
  work.interruptible(stop);
  work.step("Read", "files");
  const row = {
    ...f.props.message,
    id: "step",
    authorId: A,
    threadRootId: root,
    replyParentId: root,
    audience: "agents" as const,
    content: "Checking the files",
  };
  const { groups, byRow } = activityPresentation([row], new Set([A]), root);
  // History rows need the full session surface (reporting and its menus).
  const owner = createRelaySession(null);
  const session = { ...owner.session, ...f.props.session };
  const group = groups[0];
  if (!group) throw new Error("Missing activity history");
  const view = render(
    <>
      <div data-testid="history">
        <ActivityGroupPreview
          session={session}
          group={group}
          profiles={f.profiles}
          media={() => undefined}
          expanded
          onToggle={() => {}}
          openActivity={f.props.open}
          canOpenActivity={f.props.canOpen}
          renderHistory={(entry) => (
            <MessageRow
              row={entry}
              session={session}
              profile={f.profiles.get(A)}
              media={() => undefined}
              onOpenLink={f.props.open}
              day={false}
              retry={undefined}
              recordedActivity={{
                ...(byRow.get(entry.id) ?? { container: "bubble" }),
                container: "history",
              }}
            />
          )}
        />
      </div>
      <Conversation {...f.props} messageLayout="thread" />
    </>,
  );
  try {
    const history = screen.getByTestId("history");
    expect(within(history).getByText("Checking the files")).toBeVisible();
    expect(history.querySelector("[data-active]")).toBeNull();
    expect(end().getByText("Reading files")).toBeVisible();
    // Its one Stop is at the conversation's end; history keeps the transcript.
    expect(stopButton()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
    const activity = `buzz:profile?agent=${A}&tab=activity`;
    expect(f.props.open).toHaveBeenCalledWith(activity, { rootId: root });
    expect(claimProfileTranscript(activity)).toBeDefined();
    openEnd();
    expect(
      screen.getAllByRole("button", { name: "Stop Blossom" }),
    ).toHaveLength(1);
  } finally {
    view.unmount();
    owner.dispose();
    f.dispose();
  }
});

it("shows a local failure without requiring an ACP transcript, and opens the agent profile", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .finish({ ok: false, error: "Provider unavailable" });
    });
    expect(screen.getByText("Couldn’t finish")).toBeInTheDocument();
    const details = screen.getByRole("button", {
      name: /View agent activity: Blossom/,
    });
    expect(details.querySelector("[data-state]")).toBeNull();
    fireEvent.click(details);
    expect(screen.getByText("Provider unavailable")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View activity for Blossom" }),
    );
    const activity = `buzz:profile?agent=${A}&tab=activity`;
    expect(f.props.open).toHaveBeenCalledExactlyOnceWith(activity);
    expect(claimProfileTranscript(activity)).toBeDefined();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("keeps the outcome popup when opening the transcript fails, and removes it when access is revoked", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const activity = `buzz:profile?agent=${A}&tab=activity`;
  let asked: number | undefined;
  // Opening fails, after seeing whether a transcript was asked for.
  f.props.open.mockImplementation(() => {
    asked = profileTranscriptRequest(activity);
    return false;
  });
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .finish({ ok: false, error: "Provider unavailable" });
    });
    fireEvent.click(
      screen.getByRole("button", { name: /View agent activity/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "View activity for Blossom" }),
    );
    expect(f.props.open).toHaveBeenCalledExactlyOnceWith(activity);
    expect(asked).toBeDefined();
    // The failed opening leaves no request behind for a later Activity.
    expect(claimProfileTranscript(activity)).toBeUndefined();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.rerender(<ActivityAccessory {...f.props} canOpen={() => false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("keeps namesakes as separate exact identities", () => {
  const f = fixture();
  f.profiles.set(B, { name: "Blossom", isAgent: true as const });
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "b", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(A, "a", 2, "turn_completed", { outcome: "failed" });
    f.send(B, "b", 2, "turn_completed", { outcome: "failed" });
    const titles = screen
      .getAllByTitle(/Blossom/)
      .map((avatar) => avatar.getAttribute("title"));
    expect(new Set(titles).size).toBe(2);
  } finally {
    view.unmount();
    f.dispose();
  }
});

it.each(["payload", "prompt"])(
  "keeps %s thread scope through partial and full raw-record eviction",
  (scope) => {
    const f = fixture();
    // The request's thread exists, so its work is that thread's.
    f.props.message.replyCount = 1;
    const view = render(<ActivityAccessory {...f.props} />);
    try {
      f.send(A, "thread", 1, "turn_started", {
        triggeringEventIds: [root],
        ...(scope === "payload" ? { threadRootEventId: root } : {}),
      });
      f.send(A, "thread", 2, "acp_write", {
        method: "session/prompt",
        params: {
          prompt: [
            {
              type: "text",
              text: `<context>\nScope: thread\nThread root: ${root}\n</context>`,
            },
          ],
        },
      });
      for (let seq = 1; seq <= 150; seq++)
        f.send(B, "unrelated", seq, "acp_read");
      f.send(A, "thread", 3, "acp_read");
      for (let seq = 151; seq <= 201; seq++)
        f.send(B, "unrelated", seq, "acp_read");
      f.send(A, "thread", 4, "turn_completed", { outcome: "failed" });
      expect(
        screen.queryByRole("button", { name: /View agent activity/ }),
      ).not.toBeInTheDocument();
      for (let seq = 202; seq <= 402; seq++)
        f.send(B, "unrelated", seq, "acp_read");
      expect(
        screen.queryByRole("button", { name: /View agent activity/ }),
      ).not.toBeInTheDocument();
      view.rerender(<ActivityAccessory {...f.props} messageLayout="thread" />);
      expect(
        screen.getByRole("button", { name: /View agent activity: Blossom/ }),
      ).toBeInTheDocument();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);

it.each([false, true])(
  "keeps a thread request's outcome in its thread (local=%s)",
  (isLocal) => {
    const local = createLocalAgentActivity();
    const f = fixture(isLocal ? local : undefined);
    f.props.message.replyCount = 1;
    if (isLocal)
      local
        .begin({
          scope: "test",
          agent: A,
          channelId: "c",
          messageId: root,
          threadRootId: root,
          thread: true,
        })
        .finish({ ok: false, error: "Provider unavailable" });
    else {
      f.start(A, "turn");
      f.send(A, "turn", 2, "turn_completed", { outcome: "failed" });
    }
    const view = render(
      <ActivityAccessory {...f.props} messageLayout="timeline" />,
    );
    try {
      expect(
        screen.queryByLabelText("Agent activity on this message"),
      ).toBeNull();
      view.rerender(<ActivityAccessory {...f.props} messageLayout="thread" />);
      expect(
        screen.getByLabelText("Agent activity on this message"),
      ).toBeVisible();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);

it("does not show sibling thread work and reports lost freshness without pretending completion", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "other", 1, "turn_started", { triggeringEventIds: [next] });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    f.send(B, "here", 1, "turn_started", { triggeringEventIds: [root] });
    act(() => vi.advanceTimersByTime(31000));
    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
    f.send(B, "here", 2, "turn_completed");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("keeps a stopped agent visible beside another agent's persistent failure", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "failed", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "stopped", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(A, "failed", 2, "turn_completed", { outcome: "failed" });
    f.send(B, "stopped", 2, "turn_completed", { outcome: "cancelled" });
    expect(screen.getByText("Couldn’t finish")).toBeInTheDocument();
    expect(screen.getByText("Bubbles · Stopped")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /View agent activity: Blossom, failed/,
      }),
    );
    expect(screen.getByText("Bubbles · Stopped")).toBeInTheDocument();
    expect(
      screen.getByText(/This request ended before it could finish/),
    ).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it.each([
  ["failed", "Couldn’t finish"],
  ["terminated", "Couldn’t finish"],
  ["cancelled", "Stopped"],
])(
  "shows remote %s after stale activity and raw-buffer eviction",
  (outcome, label) => {
    const f = fixture();
    const view = render(<ActivityAccessory {...f.props} />);
    try {
      f.send(A, "remote", 1, "turn_started", { triggeringEventIds: [root] });
      act(() => vi.advanceTimersByTime(31000));
      expect(screen.getByText("Status unavailable")).toBeInTheDocument();
      f.send(A, "remote", 2, "turn_completed", { outcome });
      expect(screen.getByText(new RegExp(label))).toBeInTheDocument();
      for (let seq = 1; seq <= 201; seq++)
        f.send(B, "unrelated", seq, "acp_read");
      expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();
      expect(screen.getByText(new RegExp(label))).toBeInTheDocument();
      if (outcome !== "cancelled") {
        fireEvent.click(
          screen.getByRole("button", {
            name: /View agent activity: Blossom, failed/,
          }),
        );
        expect(
          screen.getByText(/This request ended before it could finish/),
        ).toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: "View activity for Blossom" }),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: /Dismiss error/ }),
        ).not.toBeInTheDocument();
      }
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);

it.each([false, true])(
  "returns focus after retiring the last error unless focus moved: %s",
  async (moved) => {
    const local = createLocalAgentActivity();
    const f = fixture(local);
    const onFocusedRemoval = vi.fn();
    const view = render(
      <>
        <button type="button">Other task</button>
        <ActivityAccessory {...f.props} onFocusedRemoval={onFocusedRemoval} />
      </>,
    );
    try {
      act(() => {
        local
          .begin({
            scope: "test",
            channelId: "c",
            threadRootId: root,
            messageId: root,
            agent: A,
          })
          .finish({ ok: false, error: "Provider unavailable" });
      });
      fireEvent.click(
        screen.getByRole("button", { name: /View agent activity/ }),
      );
      const dismiss = screen.getByRole("button", {
        name: "Dismiss error from Blossom",
      });
      act(() => dismiss.focus());
      fireEvent.click(dismiss);
      // The owned clock holds the handoff microtask after React removes the
      // popup, so a deliberate focus move wins before that handoff runs.
      expect(onFocusedRemoval).not.toHaveBeenCalled();
      if (moved)
        act(() => screen.getByRole("button", { name: "Other task" }).focus());
      await act(async () => vi.runAllTicks());
      expect(onFocusedRemoval).toHaveBeenCalledTimes(moved ? 0 : 1);
      expect(screen.queryByText("Provider unavailable")).toBeNull();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);

it("does not duplicate a replied thread failure on its channel request", () => {
  const f = fixture();
  const view = render(
    <>
      <div data-testid="request">
        <ActivityAccessory
          {...f.props}
          message={{ ...f.props.message, replyCount: 1 }}
          messageLayout="timeline"
          repliedAgents={[A]}
          representedAgents={[A]}
        />
      </div>
      <div data-testid="sibling">
        <ActivityAccessory
          {...f.props}
          message={{ ...f.props.message, id: next }}
          messageLayout="timeline"
        />
      </div>
    </>,
  );
  try {
    f.send(A, "thread", 1, "turn_started", {
      triggeringEventIds: [root],
      threadRootEventId: root,
    });
    expect(screen.getByTestId("request")).toBeEmptyDOMElement();
    f.send(A, "thread", 2, "turn_completed", { outcome: "terminated" });
    expect(screen.getByTestId("request")).toBeEmptyDOMElement();
    expect(screen.getByTestId("sibling")).toBeEmptyDOMElement();
    expect(f.props.open).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it.each(["thread", "continuation"] as const)(
  "keeps a thread request's stopped note on a %s reply",
  async (layout) => {
    const local = createLocalAgentActivity();
    const f = fixture(local);
    const reply = {
      ...f.props.message,
      id: next,
      authorId: A,
      threadRootId: root,
      replyParentId: root,
      createdAt: 2,
      content: "On it",
    };
    const view = render(
      <>
        <div data-testid="request">
          <ActivityAccessory
            {...f.props}
            messageLayout="thread"
            repliedAgents={[A]}
          />
        </div>
        <div data-testid="reply">
          <ActivityAccessory
            {...f.props}
            message={reply}
            messageLayout={layout}
            stoppedRequest={f.props.message}
          />
        </div>
      </>,
    );
    try {
      act(() => {
        local
          .begin({
            scope: "test",
            agent: A,
            channelId: "c",
            messageId: root,
            threadRootId: root,
            thread: true,
          })
          .interruptible(async () => {});
      });
      await act(() => f.props.session.agentActivity.interrupt(A, "c", root));
      expect(screen.getByTestId("request")).toBeEmptyDOMElement();
      expect(
        within(screen.getByTestId("reply")).getByText("Stopped"),
      ).toBeInTheDocument();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);

it("notes only stopped requests once their work settles", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .finish({ ok: true });
    });
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Stopped/)).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("says why a failed request could not be retried, keeping it to try again or dismiss", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<ActivityAccessory {...f.props} />);
  const retry = vi.fn(() => {
    throw new Error("Blossom isn't running here.");
  });
  const begin = (agent: string, again?: () => void) =>
    local.begin(
      {
        scope: "test",
        channelId: "c",
        threadRootId: root,
        messageId: root,
        agent,
      },
      again,
    );
  try {
    act(() => {
      begin(A, retry).finish({ ok: false, error: "Provider unavailable" });
      begin(B).finish({ ok: false, error: "Busy" });
    });
    openOutcome();
    // Only a request that can be asked again offers Retry.
    expect(
      screen.queryByRole("button", { name: "Retry Bubbles" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss error from Bubbles" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry Blossom" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Couldn’t retry Blossom. Blossom isn't running here.",
      "error",
    );
    expect(screen.getByText("Provider unavailable")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry Blossom" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss error from Blossom" }),
    );
    expect(screen.queryByText("Provider unavailable")).toBeNull();
    expect(retry).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("dismisses only that agent's error on this message, without changing other work", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const onFocusedRemoval = vi.fn();
  const view = render(
    <Conversation {...f.props} onFocusedRemoval={onFocusedRemoval} />,
  );
  const begin = (agent: string, messageId: string) =>
    local.begin({
      scope: "test",
      channelId: "c",
      threadRootId: root,
      messageId,
      agent,
    });
  try {
    act(() => {
      begin(A, root).finish({
        ok: false,
        error: "Provider unavailable after a long and detailed reason",
      });
      begin(A, next).finish({ ok: false, error: "Elsewhere" });
      begin(B, root).step("Read", "notes.txt");
    });
    // The failure is the request's; the other agent's live step is the end's.
    const failed = request().getByRole("button", {
      name: /View agent activity/,
    });
    expect(request().getByText("Couldn’t finish")).toBeVisible();
    expect(request().queryByText("Reading notes.txt")).toBeNull();
    expect(end().getByText("Reading notes.txt")).toBeVisible();
    fireEvent.click(failed);
    expect(
      screen.getByText("Provider unavailable after a long and detailed reason")
        .parentElement,
    ).toHaveAttribute("data-error");
    expect(
      screen.queryByRole("button", { name: "Dismiss error from Bubbles" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss error from Blossom" }),
    );
    expect(f.props.open).not.toHaveBeenCalled();
    expect(screen.getByTestId("request")).toBeEmptyDOMElement();
    expect(end().getByText("Reading notes.txt")).toBeVisible();
    expect(
      local.reader
        .work()
        .filter((row) => row.agent === A)
        .map((row) => [row.messageId, row.state, row.dismissed]),
    ).toEqual([
      // The outcome remains as settled evidence; only its display is hidden.
      [root, "error", true],
      [next, "error", undefined],
    ]);
  } finally {
    view.unmount();
    f.dispose();
  }
});

it.each(["waiting", "working"])(
  "stops a local request that is %s from the conversation's end, then notes it stopped on the request",
  async (state) => {
    const local = createLocalAgentActivity();
    const f = fixture(local);
    const queries = f.props.session.agentActivity;
    const interrupt = vi.fn(queries.interrupt);
    const session = {
      ...f.props.session,
      agentActivity: { ...queries, interrupt },
    };
    const stop = vi.fn(async () => {});
    const view = render(<Conversation {...f.props} session={session} />);
    try {
      act(() => {
        const work = local.begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        });
        work.interruptible(stop);
        if (state === "working") work.started();
      });
      openEnd();
      fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
      expect(interrupt).toHaveBeenCalledExactlyOnceWith(A, "c", root);
      await settle();
      expect(stop).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        "Stopped Blossom",
        "success",
      );
      expect(endTrigger()).toBeNull();
      expect(request().getByText("Blossom · Stopped")).toBeInTheDocument();
      // Handling the same message again replaces the note with its live work.
      act(() => {
        local
          .begin({
            scope: "test",
            channelId: "c",
            threadRootId: root,
            messageId: root,
            agent: A,
          })
          .started();
      });
      expect(screen.queryByText(/Stopped/)).not.toBeInTheDocument();
      expect(endTrigger()).toBeVisible();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);
it.each([
  [undefined, "timeline"],
  ["thread", "thread"],
] as const)(
  "notes a stopped request in the response lane (layout %s)",
  async (messageLayout, layout) => {
    const local = createLocalAgentActivity();
    const f = fixture(local);
    const view = render(
      <ActivityAccessory {...f.props} messageLayout={messageLayout} />,
    );
    try {
      act(() => {
        local
          .begin({
            scope: "test",
            channelId: "c",
            threadRootId: root,
            messageId: root,
            agent: A,
          })
          .interruptible(async () => {});
      });
      expect(view.container).toBeEmptyDOMElement();
      // Stop retains its exact request and response-side notice.
      await act(() => f.props.session.agentActivity.interrupt(A, "c", root));
      expect(
        screen.queryByRole("button", { name: /View thread/ }),
      ).not.toBeInTheDocument();
      // The note keeps the incoming message column instead of the list's edge.
      expect(
        screen.getByText("Blossom · Stopped").closest("[data-layout]"),
      ).toHaveAttribute("data-layout", layout);
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);
it("moves a stopped note below the agent's latest public reply", async () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const reply = {
    ...f.props.message,
    id: next,
    authorId: A,
    createdAt: 2,
    content: "On it",
  };
  const view = render(
    <>
      <div data-testid="request">
        <ActivityAccessory {...f.props} repliedAgents={[A]} />
      </div>
      <div data-testid="reply">
        <ActivityAccessory
          {...f.props}
          message={reply}
          stoppedRequest={f.props.message}
        />
      </div>
    </>,
  );
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .interruptible(async () => {});
    });
    // Neither message shows live work.
    expect(screen.getByTestId("request")).toBeEmptyDOMElement();
    expect(screen.getByTestId("reply")).toBeEmptyDOMElement();
    await act(() => f.props.session.agentActivity.interrupt(A, "c", root));
    expect(screen.getByTestId("request")).toBeEmptyDOMElement();
    expect(
      within(screen.getByTestId("reply")).getByText("Stopped"),
    ).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it.each(["failed", "terminated", "unknown"])(
  "places a remote %s caption beneath its reply without repeating the agent identity",
  (outcome) => {
    const f = fixture();
    const reply = {
      ...f.props.message,
      id: next,
      authorId: A,
      createdAt: 2,
      content: "An agent reply",
    };
    const view = render(
      <>
        <div data-testid="request">
          <ActivityAccessory
            {...f.props}
            messageLayout="thread"
            repliedAgents={[A]}
          />
        </div>
        <div data-testid="reply">
          <ActivityAccessory
            {...f.props}
            message={reply}
            messageLayout="thread"
            stoppedRequest={f.props.message}
          />
        </div>
      </>,
    );
    try {
      f.send(A, "remote", 1, "turn_started", { triggeringEventIds: [root] });
      expect(screen.getByTestId("request")).toBeEmptyDOMElement();
      expect(screen.getByTestId("reply")).toBeEmptyDOMElement();
      if (outcome === "unknown") act(() => vi.advanceTimersByTime(31000));
      else f.send(A, "remote", 2, "turn_completed", { outcome });
      expect(screen.getByTestId("request")).toBeEmptyDOMElement();
      const caption = within(screen.getByTestId("reply"));
      expect(
        caption.getByText(
          outcome === "unknown" ? "Status unavailable" : "Couldn’t finish",
        ),
      ).toBeInTheDocument();
      expect(caption.queryByText("Blossom")).not.toBeInTheDocument();
      expect(
        screen.getByTestId("reply").querySelector("[data-avatar-stack]"),
      ).toBeNull();
      fireEvent.click(
        caption.getByRole("button", { name: /View agent activity/ }),
      );
      expect(
        screen.getByRole("dialog", { name: "Agent activity" }),
      ).toHaveTextContent(
        outcome === "unknown"
          ? "Buzz couldn’t confirm"
          : "This request ended before it could finish",
      );
      expect(f.props.open).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);

it("retries a failed local request from its row, before Dismiss, which begins it again at the conversation's end", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<Conversation {...f.props} />);
  const retry = vi.fn(() => void begin());
  function begin() {
    return local.begin(
      {
        scope: "test",
        channelId: "c",
        threadRootId: root,
        messageId: root,
        agent: A,
      },
      retry,
    );
  }
  try {
    act(() => begin().finish({ ok: false, error: "Provider unavailable" }));
    openOutcome();
    const again = screen.getByRole("button", { name: "Retry Blossom" });
    expect(again).toHaveTextContent("Retry");
    expect(
      again.compareDocumentPosition(
        screen.getByRole("button", { name: "Dismiss error from Blossom" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(again);
    expect(retry).toHaveBeenCalledOnce();
    expect(f.props.open).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(screen.getByTestId("request")).toBeEmptyDOMElement();
    expect(
      end().getByRole("button", { name: "Activity: Blossom working" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Retry Blossom" }),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("hands focus back to the host when a focused Retry retires its outcome", async () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const onFocusedRemoval = vi.fn();
  const view = render(
    <ActivityAccessory {...f.props} onFocusedRemoval={onFocusedRemoval} />,
  );
  try {
    act(() => {
      local
        .begin(
          {
            scope: "test",
            channelId: "c",
            threadRootId: root,
            messageId: root,
            agent: A,
          },
          () => {
            local.begin({
              scope: "test",
              channelId: "c",
              threadRootId: root,
              messageId: root,
              agent: A,
            });
          },
        )
        .finish({ ok: false, error: "Provider unavailable" });
    });
    openOutcome();
    const again = screen.getByRole("button", { name: "Retry Blossom" });
    act(() => again.focus());
    fireEvent.click(again);
    expect(again.isConnected).toBe(false);
    await act(async () => vi.runAllTicks());
    expect(onFocusedRemoval).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("shows a local request as stopping until its harness has stopped it", async () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  let release = () => {};
  const stop = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const view = render(<Conversation {...f.props} />);
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .interruptible(stop);
    });
    openEnd();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    stopPending();
    fireEvent.click(stopButton() as HTMLElement);
    expect(stop).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    release();
    await settle();
    expect(screen.queryByText("Stopping…")).not.toBeInTheDocument();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Stopped Blossom",
      "success",
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("offers no Stop for a local request that cannot be stopped or has failed", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<Conversation {...f.props} />);
  const begin = (agent: string) =>
    local.begin({
      scope: "test",
      channelId: "c",
      threadRootId: root,
      messageId: root,
      agent,
    });
  try {
    act(() => {
      begin(A).started();
      const failed = begin(B);
      failed.interruptible(async () => {});
      failed.finish({ ok: false, error: "Provider unavailable" });
    });
    openEnd();
    expect(stopButton()).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop Bubbles" }),
    ).not.toBeInTheDocument();
    openOutcome();
    expect(
      screen.getByRole("button", { name: "Dismiss error from Bubbles" }),
    ).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("stops a hosted agent's turn through its provider in this thread", async () => {
  const f = fixture();
  const agents = hosted(true);
  const view = render(<Conversation {...f.props} agents={asAgents(agents)} />);
  try {
    f.start(A, "t");
    openEnd();
    expect(agents.interruptible).toHaveBeenCalledWith(A);
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    expect(agents.interrupt).toHaveBeenCalledExactlyOnceWith(A, {
      channelId: "c",
      threadRootId: root,
    });
    // Its turn ends when the provider reports it, so it shows as stopping.
    await settle();
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    stopPending();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Stopping Blossom",
      "success",
    );
    f.send(A, "t", 2, "turn_completed");
    expect(endTrigger()).toBeNull();
    expect(screen.getByTestId("request")).toBeEmptyDOMElement();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("offers each agent its own Stop at the conversation's end", async () => {
  const f = fixture();
  const agents = hosted(true);
  const view = render(<Conversation {...f.props} agents={asAgents(agents)} />);
  try {
    f.start(A, "t");
    f.start(B, "u");
    expect(stopButton()).not.toBeInTheDocument();
    openEnd();
    const popup = within(screen.getByRole("dialog"));
    expect(
      popup.getByRole("button", { name: "Stop Blossom" }),
    ).toHaveTextContent("Stop");
    fireEvent.click(popup.getByRole("button", { name: "Stop Bubbles" }));
    expect(agents.interrupt).toHaveBeenCalledExactlyOnceWith(B, {
      channelId: "c",
      threadRootId: root,
    });
    await settle();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Stopping Bubbles",
      "success",
    );
    expect(popup.getByRole("button", { name: "Stop Bubbles" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    stopReady();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("returns a hosted agent to its activity when its provider had nothing running to stop", async () => {
  const f = fixture();
  const view = render(
    <Conversation {...f.props} agents={asAgents(hosted(false))} />,
  );
  try {
    f.start(A, "t");
    openEnd();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    expect(
      look().getByText("No current step details received."),
    ).toBeInTheDocument();
    stopReady();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Blossom had nothing running to stop",
      "info",
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("says why a hosted agent could not be stopped and lets the owner try again", async () => {
  const f = fixture();
  const agents = hosted();
  agents.interrupt.mockRejectedValueOnce(new Error("Provider is busy."));
  const view = render(<Conversation {...f.props} agents={asAgents(agents)} />);
  try {
    f.start(A, "t");
    openEnd();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    await settle();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Couldn’t stop Blossom. Provider is busy.",
      "error",
    );
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    stopReady();
    fireEvent.click(stopButton() as HTMLElement);
    expect(agents.interrupt).toHaveBeenCalledTimes(2);
    expect(look().getByText("Stopping…")).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("forgets a stop once its agent's work here has ended", async () => {
  const f = fixture();
  const agents = hosted();
  const view = render(<Conversation {...f.props} agents={asAgents(agents)} />);
  try {
    f.start(A, "t");
    openEnd();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    f.send(A, "t", 2, "turn_completed");
    f.start(A, "u");
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    stopReady();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("offers no Stop for a hosted agent that is not interruptible, or whose activity is out of date", () => {
  const f = fixture();
  const agents = hosted();
  agents.interruptible.mockReturnValue(false);
  const view = render(<Conversation {...f.props} agents={asAgents(agents)} />);
  try {
    f.start(A, "t");
    openEnd();
    expect(stopButton()).not.toBeInTheDocument();
    // Interruptible, but no longer known to be working.
    agents.interruptible.mockReturnValue(true);
    view.rerender(<Conversation {...f.props} agents={asAgents(agents)} />);
    expect(stopButton()).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(31000));
    expect(request().getByText("Status unavailable")).toBeInTheDocument();
    expect(endTrigger()).toBeNull();
    expect(stopButton()).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("offers no Stop for a hosted agent when the host supplies no agents", () => {
  const f = fixture();
  const view = render(<Conversation {...f.props} />);
  try {
    f.start(A, "t");
    openEnd();
    expect(stopButton()).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

const NOT_STOPPED = "Blossom hasn’t stopped yet. Try again.";
const notStopped = () =>
  notify.mock.calls.filter(([title]) => title === NOT_STOPPED).length;
const elapse = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const alive = (f: ReturnType<typeof fixture>, turn: string, seq: number) =>
  f.send(A, turn, seq, "acp_read", {});

it("lets the owner try Stop again when a hosted turn is still working 30 seconds after it was stopped", async () => {
  const f = fixture();
  const agents = hosted(true);
  const view = render(<Conversation {...f.props} agents={asAgents(agents)} />);
  try {
    f.start(A, "t");
    openEnd();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    stopPending();
    elapse(15_000);
    alive(f, "t", 2);
    elapse(14_999);
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    expect(notStopped()).toBe(0);
    alive(f, "t", 3);
    elapse(1);
    expect(notify).toHaveBeenLastCalledWith(NOT_STOPPED, "error");
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    stopReady();
    fireEvent.click(stopButton() as HTMLElement);
    await settle();
    expect(agents.interrupt).toHaveBeenCalledTimes(2);
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    stopPending();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("does not let an older stop's timeout overwrite a newer stop of the same agent", async () => {
  const f = fixture();
  const agents = hosted(true);
  const view = render(<Conversation {...f.props} agents={asAgents(agents)} />);
  try {
    f.start(A, "t");
    openEnd();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    // The turn ends and the agent starts another before the first timeout.
    elapse(10_000);
    f.send(A, "t", 2, "turn_completed");
    f.start(A, "u");
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    fireEvent.click(stopButton() as HTMLElement);
    await settle();
    expect(agents.interrupt).toHaveBeenCalledTimes(2);
    // The first attempt's timeout (30s after it) passes; the second's has not.
    elapse(15_000);
    alive(f, "u", 2);
    elapse(5_000);
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    expect(notStopped()).toBe(0);
    stopPending();
    alive(f, "u", 3);
    elapse(10_000);
    expect(notStopped()).toBe(1);
    stopReady();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("shows nothing later when a stopped hosted turn ends before its 30 seconds", async () => {
  const f = fixture();
  const view = render(
    <Conversation {...f.props} agents={asAgents(hosted(true))} />,
  );
  try {
    f.start(A, "t");
    openEnd();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    elapse(10_000);
    f.send(A, "t", 2, "turn_completed");
    elapse(60_000);
    expect(notStopped()).toBe(0);
    expect(screen.queryByText("Stopping…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
