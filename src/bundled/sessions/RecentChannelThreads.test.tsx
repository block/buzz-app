// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import type {
  ChannelMessage,
  ChannelWindow,
} from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { RecentChannelThreads } from "./RecentChannelThreads";
import { createAgentLibrary } from "../../features/agents/library";
import { sessionRoots } from "./session-evidence";
import { SessionsDirectory } from "./SessionsDirectory";

afterEach(cleanup);
const root: ChannelMessage = {
  id: "a".repeat(64),
  channelId: "channel",
  authorId: "b".repeat(64),
  createdAt: 100,
  content: "An ordinary thread",
  mentions: [],
  attachments: [],
  reactions: [],
  replyCount: 1,
  participants: [],
};
it("selects shared exact roots, including zero replies, without trusting envelopes", () => {
  const variants: Partial<ChannelMessage>[] = [
    {},
    { delivery: "accepted" },
    { delivery: "seen" },
    { agentEnvelope: true },
    { replyCount: 0 },
    { delivery: "failed" },
    { delivery: "sending" },
    { delivery: "unknown" },
    { threadRootId: root.id },
    { channelId: "other" },
    { id: "not-hex" },
    {
      membership: {
        type: "member_joined",
        actor: root.authorId,
        target: root.authorId,
      },
    },
  ];
  expect(
    sessionRoots(
      variants.map((value, i) => ({
        ...root,
        id: i.toString(16).padStart(64, "0"),
        ...value,
      })),
      "channel",
    ).map((row) => row.id),
  ).toEqual([0, 1, 2, 3, 4].map((i) => i.toString(16).padStart(64, "0")));
});
it("groups and sorts latest observed messages with deterministic exact-root ties", () => {
  const now = new Date(2026, 8, 21, 14).getTime() / 1000;
  const make = (id: string, lastMessageAt: number) => ({
    rootId: id.repeat(64),
    title: id,
    replyCount: 1,
    lastMessageAt,
  });
  const openThread = vi.fn(() => true);
  render(
    <SessionsDirectory
      rows={[
        make("b", now),
        make("y", now - 86400),
        make("c", now - 3 * 86400),
        make("a", now),
      ]}
      now={now}
      openThread={openThread}
    />,
  );
  expect(
    screen.queryByRole("heading", { name: "Sessions" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Today" })).toBeVisible();
  expect(
    screen
      .getAllByRole("button")
      .slice(0, 2)
      .map((row) => row.querySelector("span > span")?.textContent),
  ).toEqual(["a", "b"]);
  expect(screen.getByRole("heading", { name: "Yesterday" })).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "September 18, 2026" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^a1 reply/ }));
  expect(openThread).toHaveBeenCalledWith("a".repeat(64));
});

function mount() {
  let window: ChannelWindow = {
    channelId: "channel",
    rows: [],
    status: "loading",
    error: undefined,
    hasMore: true,
    loadingOlder: false,
  };
  const listeners = new Set<() => void>();
  const channels = {
    ensure: vi.fn(),
    refresh: vi.fn(),
    loadOlder: vi.fn(),
    window: () => window,
    subscribeWindow: (_id: string, listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  let profiles = new Map();
  const unread = { manual: "none", observedCount: 0 };
  const session = {
    channels,
    unread: { snapshot: () => unread, subscribe: () => () => {} },
    thread: vi.fn(),
    agentLibrary: createAgentLibrary(undefined).queries,
    agentChoices: createAgentLibrary(undefined).queries,
    media: vi.fn((url) => `/media?url=${url}`),
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
    },
    observe: vi.fn(() => ({
      snapshot: () => ({ status: "ready", events: [] }),
      subscribe: () => () => {},
      refresh: vi.fn(),
      dispose: vi.fn(),
    })),
  } as unknown as RelaySession;
  const view = render(
    <RecentChannelThreads
      session={session}
      scope="scope"
      channelId="channel"
      channelName="Channel"
      openThread={() => true}
    />,
    { reactStrictMode: true },
  );
  return {
    view,
    channels,
    session,
    profiles,
    listeners,
    update(value: Partial<ChannelWindow>) {
      act(() => {
        profiles = new Map(profiles);
        window = { ...window, ...value };
        for (const listener of listeners) listener();
      });
    },
  };
}
it("uses one shared window subscription while mounted, with observable loading, retry and empty recovery", () => {
  const h = mount();
  expect(screen.getByText("Loading channel history…")).toBeInTheDocument();
  expect(
    screen.queryByText("No agent sessions found in the checked history"),
  ).not.toBeInTheDocument();
  const options = screen.getByText("History options").closest("details");
  expect(options).not.toHaveAttribute("open");
  expect(
    screen.getByText(/Checked history · replies sampled/),
  ).not.toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading channel history…",
  );
  fireEvent.click(screen.getByText("History options"));
  expect(
    screen.getByRole("button", { name: "Refresh loaded history" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByText("History options"));
  expect(h.listeners.size).toBe(1);
  h.update({ status: "error", error: "History unavailable" });
  expect(screen.getByRole("alert")).toHaveTextContent("History unavailable");
  fireEvent.click(
    screen.getByRole("button", { name: "Retry channel history" }),
  );
  expect(h.channels.refresh).toHaveBeenLastCalledWith("channel");
  h.update({ status: "loading", error: undefined });
  expect(screen.getByText("Loading channel history…")).toBeInTheDocument();
  h.update({ status: "ready", hasMore: false });
  expect(
    screen.getByText("No agent sessions found in the checked history"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Load older history" }),
  ).not.toBeInTheDocument();
  expect(h.session.thread).not.toHaveBeenCalled();
  h.view.unmount();
  expect(h.listeners.size).toBe(0);
});
it("labels cached bounded evidence and delegates refresh and older recovery to the existing owner", () => {
  const h = mount();
  h.update({ status: "ready", rows: [], freshness: "cached" });
  expect(
    screen.getByText("Showing cached channel history."),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText("History options"));
  expect(screen.getByText(/Checked history · replies sampled/)).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh loaded history" }),
  );
  expect(h.channels.refresh).toHaveBeenCalledWith("channel");
  fireEvent.click(screen.getByRole("button", { name: "Load older history" }));
  expect(h.channels.loadOlder).toHaveBeenCalledWith("channel");
  h.update({ loadingOlder: true });
  expect(
    screen.getByRole("button", { name: "Load older history" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByText("History options"));
  expect(screen.getByText("Loading older history…")).toBeVisible();
  h.update({ loadingOlder: false, error: "Older page failed" });
  expect(screen.getByRole("alert")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry channel history" }),
  );
  expect(h.channels.refresh).toHaveBeenCalledTimes(2);
  h.update({ error: undefined, historyLimited: true });
  expect(screen.getByText(/retention limit/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Load older history" }),
  ).not.toBeInTheDocument();
  expect(h.session.thread).not.toHaveBeenCalled();
});

it("keeps the same focused row when a new reply moves it across day groups", () => {
  const now = new Date(2026, 8, 21, 14).getTime() / 1000;
  const rows = [
    { rootId: "a", title: "Newer root", replyCount: 0, lastMessageAt: now },
    {
      rootId: "b",
      title: "Older root",
      replyCount: 1,
      lastMessageAt: now - 86400,
    },
  ];
  const openThread = vi.fn(() => true);
  const view = render(
    <SessionsDirectory rows={rows} now={now} openThread={openThread} />,
  );
  const older = screen.getByRole("button", { name: /Older root/ });
  older.focus();
  view.rerender(
    <SessionsDirectory
      rows={rows.map((row) =>
        row.rootId === "b" ? { ...row, lastMessageAt: now + 1 } : row,
      )}
      now={now}
      openThread={openThread}
    />,
  );
  expect(screen.getByRole("button", { name: /Older root/ })).toBe(older);
  expect(older).toHaveFocus();
  expect(screen.getAllByRole("button")[0]).toBe(older);
});

it("uses calendar dates for future days, rejects unrenderable times, and re-groups on a midnight rerender", () => {
  const now = new Date(2026, 8, 21, 23, 59).getTime() / 1000;
  const rows = [now, now + 86400, 0, NaN, Infinity, -1, 8_640_000_000_001].map(
    (lastMessageAt, i) => ({
      rootId: String(i),
      title: `Time ${i}`,
      replyCount: 0,
      lastMessageAt,
    }),
  );
  const props = { rows, now, openThread: () => true };
  const view = render(<SessionsDirectory {...props} />);
  expect(screen.getAllByRole("button")).toHaveLength(3);
  expect(
    screen.getByRole("heading", { name: "September 22, 2026" }),
  ).toBeVisible();
  expect(screen.getByRole("heading", { name: "Today" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: /Time 0/ }).querySelector("time"),
  ).toHaveAttribute("dateTime", new Date(now * 1000).toISOString());
  view.rerender(<SessionsDirectory {...props} now={now + 120} />);
  expect(
    screen.queryByRole("heading", { name: "September 22, 2026" }),
  ).toBeNull();
  expect(screen.getByRole("heading", { name: "Yesterday" })).toBeVisible();
  expect(
    screen
      .getAllByRole("button")
      .map((button) => button.querySelector("span > span")?.textContent),
  ).toEqual(["Time 1", "Time 0", "Time 2"]);
});

it("rejects invalid root dates before sorting or formatting while retaining epoch zero", () => {
  const values = [
    0,
    100,
    NaN,
    Infinity,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER,
    8_640_000_000_001,
  ];
  expect(
    sessionRoots(
      values.map((createdAt) => ({ ...root, createdAt })),
      "channel",
    ).map((row) => row.createdAt),
  ).toEqual([100, 0]);
});

it("renders the root starter and only body-safe signed agent chips using cached evidence", async () => {
  const h = mount();
  const agent = "c".repeat(64);
  const namesake = "d".repeat(64);
  h.profiles.set(root.authorId, {
    pubkey: root.authorId,
    name: "Starter",
    picture: "https://example.test/starter.png",
  });
  h.profiles.set(agent, { pubkey: agent, name: "Helper", isAgent: true });
  h.profiles.set(namesake, { pubkey: namesake, name: "Helper", isAgent: true });
  const make = (id: string, patch: Partial<ChannelMessage>) => ({
    ...root,
    id: id.repeat(64),
    participants: [agent],
    content: "@Helper do the work",
    ...patch,
  });
  h.update({
    status: "ready",
    rows: [
      make("1", { mentions: [agent] }),
      make("2", {}),
      make("3", { mentions: [agent], edited: true }),
      make("4", { mentions: [agent], content: "`@Helper` stays code" }),
      make("5", { authorId: agent }),
      make("6", { mentions: [agent, namesake] }),
      make("7", { mentions: [agent], attachmentContentRemoved: true }),
      make("8", { content: `${" ".repeat(200)}Whitespace before title` }),
    ],
  });
  await waitFor(() => expect(h.session.observe).toHaveBeenCalledTimes(1));
  const signed = document.getElementById(`session-row-${"1".repeat(64)}`);
  if (!signed) throw new Error("Missing signed root row");
  expect(within(signed).getByRole("img", { name: "Agent Helper" })).toHaveClass(
    "inline-chip",
  );
  expect(signed.querySelectorAll("button")).toHaveLength(0);
  const avatar = within(signed).getByRole("img", {
    name: "Started by Starter",
  });
  expect(avatar).toHaveAttribute("data-avatar-shape", "circle");
  expect(avatar.querySelector("img")).toHaveAttribute(
    "src",
    "/media?url=https://example.test/starter.png",
  );
  expect(signed.firstElementChild).toContainElement(avatar);
  expect(signed.lastElementChild).toBe(signed.querySelector("time"));
  expect(signed.querySelector(":scope > svg")).toBeNull();
  for (const id of ["2", "3", "4", "6", "7"]) {
    const row = document.getElementById(`session-row-${id.repeat(64)}`);
    if (!row) throw new Error("Missing plain root row");
    expect(
      within(row).queryByRole("img", { name: "Agent Helper" }),
    ).not.toBeInTheDocument();
  }
  expect(
    screen.getByRole("img", { name: "Started by Helper" }),
  ).toHaveAttribute("data-avatar-shape", "squircle");
  expect(
    screen.getByRole("button", { name: /Whitespace before title/ }),
  ).toBeVisible();
  expect(h.session.profiles.ensure).not.toHaveBeenCalled();
  expect(h.session.thread).not.toHaveBeenCalled();
});
