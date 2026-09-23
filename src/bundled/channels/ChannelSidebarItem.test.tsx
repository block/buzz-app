// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
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

it("keeps preview parents, children and drafts inert until real session capabilities attach", async () => {
  const user = userEvent.setup();
  const active = owner();
  const props = {
    channel: { id: "alpha", name: "Alpha", channelType: "stream" as const },
    session: undefined,
    working: false,
    sessionsEnabled: true,
    selected: undefined,
    collapsed: false,
    onToggle: vi.fn(),
    draft: true,
    draftSelected: false,
    sessions: [{ id: "child", name: "Child", channelType: "session" as const }],
    onSelect: vi.fn(),
    onNewSession: vi.fn(),
    onOpenThread: vi.fn(),
  };
  const view = render(<ChannelSidebarItem {...props} />);
  const parent = screen.getByRole("button", { name: "Alpha" });
  const child = screen.getByRole("button", { name: "Child, session in Alpha" });
  const draft = screen.getByRole("button", {
    name: "New session draft in Alpha",
  });
  for (const button of [parent, child, draft]) {
    expect(button).toBeDisabled();
    await user.hover(button);
    await user.click(button);
  }
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(props.onNewSession).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "More options for Alpha" }),
  ).not.toBeInTheDocument();
  expect(active.listeners.size).toBe(0);
  view.rerender(<ChannelSidebarItem {...props} session={active.session} />);
  await user.click(screen.getByRole("button", { name: "Alpha" }));
  expect(props.onSelect).toHaveBeenCalledWith("alpha");
  expect(active.listeners.size).toBeGreaterThan(0);
});
