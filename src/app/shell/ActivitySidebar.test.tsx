// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelaySession } from "../../features/relay/session";
import type { InboxItem } from "../../features/relay/inbox";
import type { Navigation } from "../../features/navigation/controller";
import {
  ActivityFilters,
  ActivitySidebar,
  ActivityScopeTabs,
  type ActivityView,
} from "./ActivitySidebar";

afterEach(cleanup);

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
      participants: [alice],
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
    channels.map((c) => [
      c.id,
      {
        ...quiet(c.id),
        ...(topLevel[c.id]
          ? {
              latestTopLevel: {
                id: `${c.id}-top`,
                authorId: alice,
                ...topLevel[c.id],
              },
            }
          : {}),
      },
    ]),
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
  ]);
  const markChannelRead = vi.fn(async () => ({}) as never);
  const session: RelaySession = {
    ...base,
    viewer,
    channels: {
      ...base.channels,
      list: () => list,
      subscribeList: () => () => {},
      ensureList() {},
    },
    sidebarPreferences: {
      ...base.sidebarPreferences,
      snapshot: () => ({
        status: "ready" as const,
        data: { sections: [], assignments: {}, starred: [], muted: [] },
      }),
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
      scope: "team",
      solo: "all",
      team: "channels",
      unread: false,
    });
    return (
      <>
        <ActivityScopeTabs view={view} onChange={setView} />
        <ActivityFilters view={view} onChange={setView} />
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

test("Team lists channels by their newest activity, threads included", () => {
  setup();
  // old-news has an older top-level message but a newer thread reply, which
  // becomes its preview.
  expect(rowNames()).toEqual(["old", "new"]);
  expect(screen.getByText("a reply in the old channel")).toBeInTheDocument();
});

test("a thread row opens the thread beside its channel", async () => {
  const { open } = setup();
  await userEvent.click(screen.getByRole("tab", { name: "Threads" }));
  await userEvent.click(screen.getByText("a reply in the old channel"));
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "conversation",
      channelId: "old",
      messageId: reply,
      threadRootId: root,
      context: "channel",
    }),
  );
});

test("Unread hides read conversations and scopes switch lists", async () => {
  setup();
  await userEvent.click(screen.getByRole("switch", { name: "Unread" }));
  expect(rowNames()).toEqual(["old"]);
  await userEvent.click(screen.getByRole("tab", { name: "Solo" }));
  await userEvent.click(screen.getByRole("switch", { name: "Unread" }));
  expect(rowNames()).toEqual(["solo"]);
  // Each scope has its own views.
  expect(
    screen.queryByRole("tab", { name: "Threads" }),
  ).not.toBeInTheDocument();
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

test("Team's Direct view lists mentions and opens them in their thread", async () => {
  const { open } = setup([mentionItem()]);
  await userEvent.click(screen.getByRole("tab", { name: "Direct" }));
  await userEvent.click(screen.getByText("hey @you"));
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      channelId: "new",
      threadRootId: root,
      context: "channel",
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
  expect(rowNames()).toEqual(["old", "new"]);
  expect(screen.getByText("a new post")).toBeInTheDocument();
  expect(screen.queryByText(/Alice/)).not.toBeInTheDocument();
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

test("Direct interleaves DMs and mentions of you, newest first", async () => {
  setup([mentionItem()]);
  await userEvent.click(screen.getByRole("tab", { name: "Direct" }));
  const items = within(screen.getByRole("list", { name: "Conversations" }))
    .getAllByRole("listitem")
    .map((li) => li.getAttribute("data-activity-row") ?? li.textContent);
  // The mention (500) is newer than the DM (450); Team channels stay out.
  expect(items).toHaveLength(2);
  expect(items[0]).toContain("hey @you");
  expect(items[1]).toBe("dm");
});

test("Solo's Working and Waiting split chats by whose move it is", async () => {
  setup([], { solo: { createdAt: 300, content: "done, have a look" } }, []);
  await userEvent.click(screen.getByRole("tab", { name: "Solo" }));
  expect(rowNames()).toEqual(["solo"]);
  await userEvent.click(screen.getByRole("tab", { name: "Working" }));
  expect(rowNames()).toEqual([]);
  expect(
    screen.getByText("No agent is working right now."),
  ).toBeInTheDocument();
  // The agent spoke last and isn't working: it is waiting on you.
  await userEvent.click(screen.getByRole("tab", { name: "Waiting" }));
  expect(rowNames()).toEqual(["solo"]);
});

test("a chat with a working agent is Working, not Waiting", async () => {
  setup([], { solo: { createdAt: 300, content: "on it" } }, ["solo"]);
  await userEvent.click(screen.getByRole("tab", { name: "Solo" }));
  await userEvent.click(screen.getByRole("tab", { name: "Working" }));
  expect(rowNames()).toEqual(["solo"]);
  await userEvent.click(screen.getByRole("tab", { name: "Waiting" }));
  expect(rowNames()).toEqual([]);
});

test("your own last message is not Waiting", async () => {
  setup([], { solo: { createdAt: 300, content: "go", authorId: viewer } });
  await userEvent.click(screen.getByRole("tab", { name: "Solo" }));
  await userEvent.click(screen.getByRole("tab", { name: "Waiting" }));
  expect(rowNames()).toEqual([]);
});

/** The initial a row's avatar shows, standing in for the picture. */
const faceOf = (id: string) =>
  document
    .querySelector(`[data-activity-row="${id}"] [data-avatar-fallback]`)
    ?.textContent?.trim();

test("a DM row is titled with its people, not DM", async () => {
  setup();
  await userEvent.click(screen.getByRole("tab", { name: "Direct" }));
  const row = document.querySelector('[data-activity-row="dm"]');
  expect(row).toHaveTextContent("Alice");
  expect(row).not.toHaveTextContent(/^DM/);
});

test("your own latest message shows your avatar, with no You prefix", () => {
  setup([], { new: { createdAt: 600, content: "my post", authorId: viewer } });
  expect(faceOf("new")).toBe("Z");
  expect(screen.queryByText(/You/)).not.toBeInTheDocument();
});

test("a Solo row shows whoever posted last, not the agent that started it", async () => {
  setup([], { solo: { createdAt: 300, content: "joined in" } });
  await userEvent.click(screen.getByRole("tab", { name: "Solo" }));
  expect(faceOf("solo")).toBe("A");
});

test("a Solo row with no known message shows its agent", async () => {
  setup();
  await userEvent.click(screen.getByRole("tab", { name: "Solo" }));
  expect(faceOf("solo")).toBe("B");
});
