// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import type {
  ThreadActivitySnapshot,
  UnreadSnapshot,
} from "../../features/relay/unread";
import { ChannelSidebarRow } from "./ChannelSidebarRow";
import { UnreadBadge } from "./UnreadBadge";

afterEach(cleanup);
const parent = {
  id: "parent",
  name: "Engineering",
  channelType: "stream" as const,
};
function unreadSession(observedCount = 1) {
  const snapshot: UnreadSnapshot = {
    target: { kind: "channel", channelId: "child" },
    observedCount,
    attentionCount: 0,
    coverage: "observed",
    freshness: "observed",
    manual: "none",
  };
  const activity: ThreadActivitySnapshot = {
    channelId: "child",
    items: [],
    coverage: "observed",
    freshness: "observed",
  };
  return {
    unread: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      activity: () => activity,
      subscribeActivity: () => () => {},
    },
  } as unknown as RelaySession;
}
function mount(selected = "child") {
  const onSelect = vi.fn(),
    onNewSession = vi.fn();
  const session = unreadSession();
  function Row() {
    const [collapsed, setCollapsed] = useState(false);
    return (
      <ChannelSidebarRow
        channel={parent}
        collapsed={collapsed}
        onToggle={(open) => setCollapsed(!open)}
        icon={<svg data-testid="channel-icon" />}
        badge={<span>3</span>}
        childContent={(channel) => (
          <UnreadBadge
            session={session}
            channelId={channel.id}
            label={channel.name}
          />
        )}
        sessions={[
          {
            id: "child",
            name: "Plan the release",
            channelType: "session",
            parentChannelId: parent.id,
          },
        ]}
        draft={true}
        draftSelected={false}
        selected={selected}
        onSelect={onSelect}
        onPrepare={() => {}}
        onNewSession={onNewSession}
      />
    );
  }
  render(<Row />);
  return { onSelect, onNewSession };
}
it("opens a compact action menu independently of selecting its channel", async () => {
  const user = userEvent.setup();
  const callbacks = mount();
  const trigger = screen.getByRole("button", {
    name: "More options for Engineering",
  });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "New session" }),
  );
  expect(callbacks.onNewSession).toHaveBeenCalledWith("parent");
  expect(callbacks.onSelect).not.toHaveBeenCalled();
  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
});
it("opens saved child sessions and retained drafts without a channel icon", async () => {
  const user = userEvent.setup();
  const callbacks = mount();
  const child = screen.getByRole("button", {
    name: "Plan the release, session in Engineering",
  });
  expect(child).toHaveAttribute("aria-current", "page");
  expect(child.querySelector("svg")).toBeNull();
  expect(child.querySelector("[data-channel-unread]")).toBeInTheDocument();
  await user.click(child);
  expect(callbacks.onSelect).toHaveBeenCalledWith("child");
  await user.click(
    screen.getByRole("button", { name: "New session draft in Engineering" }),
  );
  expect(callbacks.onNewSession).toHaveBeenCalledWith("parent");
});

it("visibly marks an ordinary unread child session without a priority dot", () => {
  mount("");
  const child = screen.getByRole("button", {
    name: "Plan the release, session in Engineering",
  });
  expect(child).not.toHaveAttribute("aria-current");
  expect(
    child.querySelector('[data-channel-unread-title="true"]'),
  ).toHaveTextContent("Plan the release");
  expect(child.querySelector("[data-channel-unread]")).toBeInTheDocument();
  expect(child.querySelector("[data-channel-priority]")).toBeNull();
});

it("collapses child sessions and drafts without navigating and expands with the keyboard", async () => {
  const user = userEvent.setup();
  const callbacks = mount();
  const toggle = screen.getByRole("button", {
    name: "Collapse sessions in Engineering",
  });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("button", {
      name: "Plan the release, session in Engineering",
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "New session draft in Engineering" }),
  ).not.toBeInTheDocument();
  expect(callbacks.onSelect).not.toHaveBeenCalled();
  expect(callbacks.onNewSession).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(
    screen.getByRole("button", {
      name: "Plan the release, session in Engineering",
    }),
  ).toHaveAttribute("aria-current", "page");
});
