// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelaySession } from "../../features/relay/session";
import type { InboxItem } from "../../features/relay/inbox";
import type { Navigation } from "../../features/navigation/controller";
import {
  ActivityFilters,
  ConversationList as ActivitySidebar,
  type ActivityView,
} from "../../features/conversation/ConversationList";

/** Solo offers Working and Waiting; Team offers DMs, Mentions and Channels. */
let soloViews = false;
/** The roster head read's progress, which the test moves by hand. */
let headsStatus: ReturnType<RelaySession["channelHeads"]["status"]> = "ready";
const headListeners = new Set<(ids?: readonly string[]) => void>();
afterEach(() => {
  soloViews = false;
  headsStatus = "ready";
  headListeners.clear();
  cleanup();
});

const viewer = "c".repeat(64);
const alice = "a".repeat(64);
const bob = "b".repeat(64);
const root = "d".repeat(64);
const reply = "e".repeat(64);
const scope = { viewer, communityOrigin: "https://relay.test" };

function setup(
  inboxItems: InboxItem[] = [],
  topLevel: Record<
    string,
    { createdAt: number; content: string; authorId?: string }
  > = {},
  workingIn: readonly string[] = [],
  dmParticipants: readonly string[] = [alice],
) {
  const base = createRelaySession(null).session;
  const channels = [
    {
      id: "old",
      name: "old-news",
      channelType: "stream" as const,
      lastActivityAt: 100,
      preview: "ancient",
    },
    {
      id: "new",
      name: "fresh",
      channelType: "stream" as const,
      lastActivityAt: 200,
      preview: "hello there",
    },
    {
      id: "solo",
      name: "My chat",
      channelType: "solo" as const,
      // Bob, the agent, started it; Alice joined later.
      members: [viewer, bob, alice],
      lastActivityAt: 300,
    },
    {
      id: "dm",
      name: "DM",
      channelType: "dm" as const,
      participants: dmParticipants,
      lastActivityAt: 450,
    },
  ];
  const list = { status: "ready" as const, channels };
  const quiet = (channelId: string) => ({
    target: { kind: "channel" as const, channelId },
    observedCount: channelId === "old" ? 2 : 0,
    attentionCount: 0,
    coverage: "observed" as const,
    freshness: "observed" as const,
    manual: "none" as const,
  });
  const snapshots = new Map(
    channels.map((c) => {
      const top = topLevel[c.id];
      return [
        c.id,
        {
          ...quiet(c.id),
          ...(top
            ? { latestTopLevel: { id: `${c.id}-top`, authorId: alice, ...top } }
            : {}),
        },
      ] as const;
    }),
  );
  const thread = {
    channelId: "old",
    rootId: root,
    latestMessageId: reply,
    authorId: alice,
    createdAt: 400,
    preview: "a reply in the old channel",
    unreadCount: 1,
  };
  const activities = new Map(
    channels.map((c) => [
      c.id,
      {
        channelId: c.id,
        items: c.id === "old" ? [thread] : [],
        coverage: "observed" as const,
        freshness: "observed" as const,
      },
    ]),
  );
  const inbox = {
    status: "ready" as const,
    items: inboxItems,
    freshness: "observed" as const,
  };
  const profiles = new Map<string, { name: string; isAgent?: true }>([
    [alice, { name: "Alice" }],
    [bob, { name: "Bob", isAgent: true }],
    [viewer, { name: "Zed" }],
    [root, { name: "Dana" }],
    [reply, { name: "Eli" }],
  ]);
  const markChannelRead = vi.fn(async () => ({}) as never);
  const sidebar = {
    status: "ready" as const,
    data: { sections: [], assignments: {}, starred: [], muted: [] },
  };
  const session: RelaySession = {
    ...base,
    channelHeads: {
      latest: (id) => snapshots.get(id)?.latestTopLevel,
      settled: () => headsStatus === "ready",
      status: () => headsStatus,
      subscribe: (listener) => {
        headListeners.add(listener);
        return () => headListeners.delete(listener);
      },
    },
    viewer,
    channels: {
      ...base.channels,
      list: () => list,
      subscribeList: () => () => {},
      ensureList() {},
    },
    sidebarPreferences: {
      ...base.sidebarPreferences,
      snapshot: () => sidebar,
    },
    profiles: {
      ...base.profiles,
      snapshot: () => profiles,
      ensure: async () => {},
    },
    inboxFeed: { ...base.inboxFeed, ensure: async () => {} },
    agentActivity: {
      ...base.agentActivity,
      subscribe: () => () => {},
      snapshot: () =>
        ({
          ...base.agentActivity.snapshot(),
          turns: workingIn.map((channelId, index) => ({
            agent: alice,
            turnId: `t${index}`,
            channelId,
            timestamp: 1,
            state: "working" as const,
          })),
          typing: [],
        }) as never,
    },
    unread: {
      ...base.unread,
      markChannelRead,
      ensure: async () => {},
      inbox: () => inbox as never,
      subscribeInbox: () => () => {},
      snapshot: (target) =>
        snapshots.get(target.kind === "channel" ? target.channelId : "") ??
        quiet("none"),
      subscribe: () => () => {},
      activity: (id) =>
        activities.get(id) ?? {
          channelId: id,
          items: [],
          coverage: "observed",
          freshness: "observed",
        },
      subscribeActivity: () => () => {},
    },
  };
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const navigator = { open } as unknown as Navigation;
  function Harness() {
    const [view, setView] = useState<ActivityView>({
      filter: "all",
      unread: false,
    });
    return (
      <>
        <ActivityFilters
          title="Team"
          view={view}
          onChange={setView}
          agentViews={soloViews}
        />
        <ActivitySidebar
          session={session}
          navigator={navigator}
          scope={scope}
          target={
            { version: 1, kind: "page", pluginId: "x", pageId: "y" } as never
          }
          view={view}
        />
      </>
    );
  }
  render(<Harness />);
  return { open, markChannelRead };
}

const rowNames = () =>
  within(screen.getByRole("list", { name: "Conversations" }))
    .queryAllByRole("listitem")
    .filter((li) => li.hasAttribute("data-activity-row"))
    .map((li) => li.getAttribute("data-activity-row"));

test.each(["loading", "idle"] as const)(
  "Waiting says nothing is waiting only once every head is read (%s)",
  async (status) => {
    soloViews = true;
    headsStatus = status;
    setup();
    await userEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    expect(rowNames()).toEqual([]);
    // Until the roster read lands, an empty answer proves nothing.
    expect(
      screen.queryByText("Nothing is waiting on you"),
    ).not.toBeInTheDocument();
    act(() => {
      headsStatus = "ready";
      for (const listener of [...headListeners]) listener([]);
    });
    expect(screen.getByText("Nothing is waiting on you")).toBeInTheDocument();
  },
);

test("Working answers at once without waiting for heads", async () => {
  soloViews = true;
  headsStatus = "loading";
  setup();
  await userEvent.click(screen.getByRole("tab", { name: "Working" }));
  expect(screen.getByText("No agent is working right now")).toBeInTheDocument();
});

test("All interleaves chats, DMs, and channels by their newest activity", () => {
  setup();
  // old-news has an older top-level message but a newer thread reply, which
  // becomes its preview.
  expect(rowNames()).toEqual(["dm", "old", "solo", "new"]);
  expect(screen.queryByRole("tab", { name: "Solo" })).not.toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "Team" })).not.toBeInTheDocument();
  expect(screen.getByText("a reply in the old channel")).toBeInTheDocument();
});

test("a thread row opens the thread on its own", async () => {
  const { open } = setup();
  await userEvent.click(screen.getByRole("tab", { name: "Threads" }));
  await userEvent.click(screen.getByText("a reply in the old channel"));
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "conversation",
      channelId: "old",
      messageId: reply,
      threadRootId: root,
      context: "thread",
    }),
  );
});

test("Unread filters the combined list and can restore every kind of conversation", async () => {
  setup();
  const menu = screen.getByRole("button", {
    name: "Filter and sort conversations",
  });
  await userEvent.click(menu);
  await userEvent.click(
    await screen.findByRole("menuitemradio", { name: "Unread only" }),
  );
  expect(rowNames()).toEqual(["old"]);
  await userEvent.click(menu);
  await userEvent.click(
    await screen.findByRole("menuitemradio", { name: "All conversations" }),
  );
  expect(rowNames()).toEqual(["dm", "old", "solo", "new"]);
  expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

const mentionItem = () => {
  const mention = {
    id: "m",
    channelId: "new",
    target: { kind: "thread", channelId: "new", rootId: root },
    messageId: reply,
    latestMessageId: reply,
    messageIds: [reply],
    rootId: root,
    authorId: alice,
    preview: "hey @you",
    createdAt: 500,
    mentioned: true,
    messages: [],
    thread: true,
    unreadCount: 1,
    manual: false,
    readThrough: [],
  } as unknown as InboxItem;
  return { ...mention, mention } as InboxItem;
};

test("Team's Mentions view lists mentions and opens them in their thread", async () => {
  const { open } = setup([mentionItem()]);
  await userEvent.click(screen.getByRole("tab", { name: "Mentions" }));
  await userEvent.click(screen.getByText("hey @you"));
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      channelId: "new",
      threadRootId: root,
      context: "thread",
    }),
  );
});

test("Team's Threads view is a flat list of threads, not channels", async () => {
  setup();
  await userEvent.click(screen.getByRole("tab", { name: "Threads" }));
  expect(rowNames()).toEqual([]);
  expect(screen.getByText("in #old-news")).toBeInTheDocument();
  expect(screen.getByLabelText("Thread")).toBeInTheDocument();
  expect(screen.queryByText("ancient")).not.toBeInTheDocument();
});

test("a Team row previews its latest top-level message, without its author", () => {
  setup([], {
    old: { createdAt: 600, content: "a new post" },
    new: { createdAt: 150, content: "older post" },
  });
  expect(rowNames()).toEqual(["old", "dm", "solo", "new"]);
  expect(screen.getByText("a new post")).toBeInTheDocument();
  const row = document.querySelector<HTMLElement>('[data-activity-row="old"]');
  if (!row) throw new Error("Conversation row missing");
  expect(within(row).queryByText("Alice")).not.toBeInTheDocument();
});

test("an unread row's checkmark marks its channel read without opening it", async () => {
  const { open, markChannelRead } = setup();
  const row = screen
    .getAllByRole("listitem")
    .find((li) => li.getAttribute("data-activity-row") === "old");
  if (!row) throw new Error("missing row");
  await userEvent.click(
    within(row).getByRole("button", { name: "Mark as read" }),
  );
  expect(markChannelRead).toHaveBeenCalledWith("old");
  expect(open).not.toHaveBeenCalled();
  // A read row offers no checkmark.
  const read = screen
    .getAllByRole("listitem")
    .find((li) => li.getAttribute("data-activity-row") === "new");
  expect(
    within(read as HTMLElement).queryByRole("button", { name: "Mark as read" }),
  ).not.toBeInTheDocument();
});

test("DMs and Mentions each list only their own rows", async () => {
  setup([mentionItem()]);
  const items = () =>
    within(screen.getByRole("list", { name: "Conversations" }))
      .getAllByRole("listitem")
      .map((li) => li.getAttribute("data-activity-row") ?? li.textContent);
  // Chats, channels and mentions stay out of DMs.
  await userEvent.click(screen.getByRole("tab", { name: "DMs" }));
  expect(items()).toEqual(["dm"]);
  await userEvent.click(screen.getByRole("tab", { name: "Mentions" }));
  expect(items()).toHaveLength(1);
  expect(items()[0]).toContain("hey @you");
});

test.each([
  {
    workingIn: ["solo"],
    authorId: alice,
    workingRows: ["solo"],
    waitingRows: [],
  },
  { workingIn: [], authorId: alice, workingRows: [], waitingRows: ["solo"] },
  { workingIn: [], authorId: viewer, workingRows: [], waitingRows: [] },
])(
  "Working and Waiting preserve whose move it is: $authorId / $workingIn",
  async ({ workingIn, authorId, workingRows, waitingRows }) => {
    soloViews = true;
    setup(
      [],
      { solo: { createdAt: 300, content: "on it", authorId } },
      workingIn,
    );
    await userEvent.click(screen.getByRole("tab", { name: "Working" }));
    expect(rowNames()).toEqual(workingRows);
    if (workingRows.length) {
      expect(
        document.querySelector(
          '[data-activity-row="solo"] [data-conversation-row]',
        ),
      ).toHaveAttribute("data-state", "working");
    } else {
      expect(
        screen.getByText("No agent is working right now"),
      ).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    expect(rowNames()).toEqual(waitingRows);
    if (!waitingRows.length)
      expect(screen.getByText("Nothing is waiting on you")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(rowNames()).toEqual(["dm", "old", "solo", "new"]);
  },
);

test("your newest chat message moves it ahead of channels and DMs", () => {
  setup([], { solo: { createdAt: 600, content: "go", authorId: viewer } });
  expect(rowNames()).toEqual(["solo", "dm", "old", "new"]);
});

/** The initial a row's avatar shows, standing in for the picture. */
const faceOf = (id: string) =>
  document
    .querySelector(`[data-activity-row="${id}"] [data-avatar-fallback]`)
    ?.textContent?.trim();

test("a DM row is titled with its people, not DM", async () => {
  setup();
  await userEvent.click(screen.getByRole("tab", { name: "DMs" }));
  const row = document.querySelector('[data-activity-row="dm"]');
  expect(row).toHaveTextContent("Alice");
  expect(row).not.toHaveTextContent(/^DM/);
});

test("a channel shows who posted last", () => {
  setup([], { new: { createdAt: 600, content: "a post", authorId: alice } });
  expect(faceOf("new")).toBe("A");
  expect(screen.getByText("a post")).toBeInTheDocument();
});

test.each([alice, viewer])(
  "a Solo row shows its other members regardless of the last sender %s",
  async (authorId) => {
    setup([], { solo: { createdAt: 300, content: "joined in", authorId } });
    const row = document.querySelector<HTMLElement>(
      '[data-activity-row="solo"]',
    );
    if (!row) throw new Error("Conversation row missing");
    expect(row.querySelectorAll("[data-avatar-fallback]")).toHaveLength(2);
    expect(within(row).getByTitle("Bob")).toBeInTheDocument();
    expect(within(row).getByTitle("Alice")).toBeInTheDocument();
    expect(within(row).queryByTitle("Zed")).not.toBeInTheDocument();
  },
);

test("a group DM shows at most three other participants", async () => {
  setup(
    [],
    { dm: { createdAt: 600, content: "my reply", authorId: viewer } },
    [],
    [viewer, alice, bob, root, reply],
  );
  await userEvent.click(screen.getByRole("tab", { name: "DMs" }));
  const row = document.querySelector<HTMLElement>('[data-activity-row="dm"]');
  if (!row) throw new Error("Conversation row missing");
  expect(row.querySelectorAll("[data-avatar-fallback]")).toHaveLength(3);
  for (const name of ["Alice", "Bob", "Dana"])
    expect(within(row).getByTitle(name)).toBeInTheDocument();
  expect(within(row).queryByTitle("Zed")).not.toBeInTheDocument();
  expect(within(row).queryByTitle("Eli")).not.toBeInTheDocument();
});

test("a Solo row with no known message shows its agent", async () => {
  setup();
  expect(faceOf("solo")).toBe("B");
});
