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
it("offers a separate hide action only for DM rows", async () => {
  const onHideDm = vi.fn();
  const onSelect = vi.fn();
  render(
    <ChannelSidebarRow
      channel={{ id: "dm", name: "Alice", channelType: "dm" }}
      collapsed={false}
      onToggle={() => {}}
      icon={<svg />}
      sessions={[]}
      draft={false}
      draftSelected={false}
      onSelect={onSelect}
      onPrepare={() => {}}
      onNewSession={() => {}}
      onHideDm={onHideDm}
    />,
  );
  const remove = screen.getByRole("button", {
    name: "Remove Alice from DMs",
  });
  expect(remove).not.toHaveAttribute("title");
  await userEvent.setup().click(remove);
  expect(onHideDm).toHaveBeenCalledWith("dm");
  expect(onSelect).not.toHaveBeenCalled();
});
it("keeps focus in the sidebar when removing its last visible DM", async () => {
  function OnlyDm() {
    const [visible, setVisible] = useState(true);
    return (
      <div>
        <div data-sidebar-section="">
          <details open>
            <summary>Channels</summary>
          </details>
        </div>
        {visible && (
          <div data-sidebar-section="">
            <details open>
              <summary>DMs</summary>
            </details>
            <ChannelSidebarRow
              channel={{ id: "dm", name: "Alice", channelType: "dm" }}
              collapsed={false}
              onToggle={() => {}}
              icon={<svg />}
              sessions={[]}
              draft={false}
              draftSelected={false}
              onSelect={() => {}}
              onPrepare={() => {}}
              onNewSession={() => {}}
              onHideDm={() => setVisible(false)}
            />
          </div>
        )}
      </div>
    );
  }
  render(<OnlyDm />);
  const remove = screen.getByRole("button", { name: "Remove Alice from DMs" });
  remove.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(screen.queryByText("DMs")).not.toBeInTheDocument();
  expect(screen.getByText("Channels")).toHaveFocus();
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
