// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { UnreadSnapshot } from "../../features/relay/unread";
import { ChannelSidebarItem } from "./ChannelSidebarItem";

afterEach(cleanup);

function owner() {
  const listeners = new Set<() => void>();
  let snapshot: UnreadSnapshot = {
    target: { kind: "channel", channelId: "alpha" },
    observedCount: 0,
    attentionCount: 0,
    coverage: "observed",
    freshness: "observed",
    manual: "none",
  };
  const activity = {
    channelId: "alpha",
    items: [],
    coverage: "observed",
    freshness: "observed",
  };
  const session = {
    channels: { prepare: vi.fn() },
    unread: {
      snapshot: () => snapshot,
      subscribe: (_target: unknown, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      activity: () => activity,
      subscribeActivity: () => () => {},
    },
  } as unknown as RelaySession;
  return {
    session,
    listeners,
    unread(count: number) {
      snapshot = { ...snapshot, observedCount: count };
      for (const listener of listeners) listener();
    },
  };
}

it("keeps live unread updates and uses replacement session callbacks across row updates", async () => {
  const user = userEvent.setup(),
    first = owner(),
    second = owner();
  const onSelect = vi.fn(),
    replacement = vi.fn();
  const props = {
    channel: { id: "alpha", name: "Alpha", channelType: "stream" as const },
    session: first.session,
    working: false,
    sessionsEnabled: true,
    selected: undefined,
    collapsed: false,
    onToggle: vi.fn(),
    draft: false,
    draftSelected: false,
    sessions: undefined,
    onSelect,
    onNewSession: vi.fn(),
    onOpenThread: vi.fn(),
  };
  const view = render(<ChannelSidebarItem {...props} />);
  const row = screen.getByRole("button", { name: "Alpha" });
  view.rerender(<ChannelSidebarItem {...props} />);
  act(() => first.unread(2));
  expect(
    screen.getByRole("img", { name: /2 observed unread/ }),
  ).toBeInTheDocument();
  await user.click(row);
  expect(onSelect).toHaveBeenCalledWith("alpha");
  view.rerender(
    <ChannelSidebarItem
      {...props}
      session={second.session}
      working
      selected="alpha"
      onSelect={replacement}
    />,
  );
  expect(screen.getByRole("button", { name: /^Alpha/ })).toBe(row);
  expect(row).toHaveAttribute("aria-current", "page");
  expect(
    screen.getByRole("img", { name: "Agent working" }),
  ).toBeInTheDocument();
  expect(first.listeners.size).toBe(0);
  expect(
    screen.queryByRole("img", { name: /observed unread/ }),
  ).not.toBeInTheDocument();
  act(() => second.unread(3));
  expect(
    screen.getByRole("img", { name: /3 observed unread/ }),
  ).toBeInTheDocument();
  await user.click(row);
  expect(replacement).toHaveBeenCalledWith("alpha");
  expect(onSelect).toHaveBeenCalledTimes(1);
});

it("renders one-to-one DM avatars from supplied profiles only, through the media sanitizer", () => {
  const session = owner().session;
  // Any new row-owned profile/presence subscription fails this test.
  Object.defineProperties(session, {
    profiles: {
      get: () => {
        throw new Error("Unexpected profile acquisition");
      },
    },
    presence: {
      get: () => {
        throw new Error("Unexpected presence acquisition");
      },
    },
  });
  session.media = vi.fn((url) =>
    url.startsWith("https://") ? `/media?url=${url}` : undefined,
  );
  const props = {
    channel: {
      id: "dm",
      name: "Alice",
      channelType: "dm" as const,
      participants: ["alice"],
    },
    session,
    working: false,
    sessionsEnabled: false,
    selected: undefined,
    collapsed: false,
    onToggle: vi.fn(),
    draft: false,
    draftSelected: false,
    sessions: undefined,
    onSelect: vi.fn(),
    onNewSession: vi.fn(),
    onOpenThread: vi.fn(),
  };
  const view = render(<ChannelSidebarItem {...props} />);
  const row = screen.getByRole("button", { name: "Alice", exact: true });
  expect(row.querySelector(".buzz-avatar")).toHaveTextContent("A");
  view.rerender(
    <ChannelSidebarItem
      {...props}
      profile={{
        name: "Alice",
        picture: "https://example.com/alice.png",
        isAgent: true,
      }}
    />,
  );
  expect(session.media).toHaveBeenLastCalledWith(
    "https://example.com/alice.png",
    "small",
  );
  const image = row.querySelector("img");
  expect(image).toHaveAttribute(
    "src",
    "/media?url=https://example.com/alice.png",
  );
  expect(image).toHaveAttribute("loading", "lazy");
  expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(row.querySelector(".buzz-avatar")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  if (!image) throw new Error("Avatar image is missing");
  fireEvent.error(image);
  expect(row.querySelector("img")).toBeNull();
  expect(row.querySelector(".buzz-avatar")).toHaveTextContent("A");
  view.rerender(
    <ChannelSidebarItem
      {...props}
      profile={{ name: "Alice", picture: "javascript:bad" }}
    />,
  );
  expect(row.querySelector("img")).toBeNull();
  expect(row.querySelector(".buzz-avatar")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  view.rerender(<ChannelSidebarItem {...props} profile={undefined} />);
  expect(row.querySelector(".buzz-avatar")).toHaveTextContent("A");
  for (const participants of [[], ["alice", "bob"]]) {
    view.rerender(
      <ChannelSidebarItem
        {...props}
        channel={{ ...props.channel, participants }}
      />,
    );
    expect(row.querySelector(".buzz-avatar")).toBeNull();
    expect(row).toHaveAccessibleName("Alice");
    if (participants.length) {
      expect(
        row.querySelector("[title='2 other participants']"),
      ).toHaveTextContent("2");
    } else expect(row.querySelector("svg")).toBeInTheDocument();
  }
});
