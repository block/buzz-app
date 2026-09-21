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
it("groups and sorts explicitly by root start, with exact-root ties, never reply activity", () => {
  const now = new Date(2026, 8, 21, 14).getTime() / 1000;
  const make = (id: string, startedAt: number) => ({
    rootId: id.repeat(64),
    title: id,
    replyCount: 1,
    startedAt,
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
  expect(screen.getByText(/Ordered by thread start/)).toHaveTextContent(
    "not the latest reply",
  );
  const today = within(screen.getByRole("region", { name: "Started Today" }));
  expect(
    today
      .getAllByRole("button")
      .map((row) => row.querySelector("strong")?.textContent),
  ).toEqual(["a", "b"]);
  expect(
    screen.getByRole("region", { name: "Started Yesterday" }),
  ).toHaveTextContent("y");
  expect(
    screen.getByRole("region", { name: "Started September 18, 2026" }),
  ).toHaveTextContent("c");
  fireEvent.click(today.getByRole("button", { name: /^a1 reply/ }));
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
  const profiles = new Map();
  const session = {
    channels,
    thread: vi.fn(),
    agentLibrary: createAgentLibrary(undefined).queries,
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
    listeners,
    update(value: Partial<ChannelWindow>) {
      act(() => {
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
  expect(
    screen.getByRole("button", { name: "Refresh loaded history" }),
  ).toBeDisabled();
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
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh loaded history" }),
  );
  expect(h.channels.refresh).toHaveBeenCalledWith("channel");
  fireEvent.click(screen.getByRole("button", { name: "Load older history" }));
  expect(h.channels.loadOlder).toHaveBeenCalledWith("channel");
  h.update({ loadingOlder: true });
  expect(
    screen.getByRole("button", { name: "Loading older history…" }),
  ).toBeDisabled();
  h.update({ loadingOlder: false, error: "Older page failed" });
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
