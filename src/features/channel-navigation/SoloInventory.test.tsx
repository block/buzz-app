// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { writeView } from "../../shared/view-state";
import { conversationTarget, soloDraftTarget } from "./routes";
import type { Contribution } from "../../plugins/contributions";
import type { ChatIcon, ChatMenu } from "../conversation/service";
import type { Profile } from "../relay/contracts";

import {
  fixture,
  owners,
  id,
  other,
  agent,
  outsider,
  root,
  scope,
} from "../../app/shell/sidebar-testing";
stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["unavailable", "cached", "readOnly"])(
  "immediately opens a narrow Solo row when rename is %s",
  (state) => {
    const f = fixture();
    Object.assign(f.session, {
      channelDetails: {
        ...f.session.channelDetails,
        available: state !== "unavailable",
      },
    });
    if (state !== "unavailable") {
      const channel = f.session.channels
        .list()
        .channels.find((item) => item.id === id);
      if (!channel) throw new Error("Missing Planning fixture");
      Object.assign(channel, { [state]: true });
    }
    f.replaceSession();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 650px)",
      addEventListener() {},
      removeEventListener() {},
    }));
    const row = screen.getByRole("button", { name: /^Planning/ });
    fireEvent.click(row, { detail: 1 });
    expect(f.open).toHaveBeenLastCalledWith(conversationTarget(scope, id));
    fireEvent.click(row, { detail: 2 });
    fireEvent.doubleClick(row);
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull();
  },
);

it("opens the chat if rename admission changes before the double-click completes", () => {
  const f = fixture();
  const details = { ...f.session.channelDetails, available: true };
  Object.assign(f.session, { channelDetails: details });
  f.replaceSession();
  const row = screen.getByRole("button", { name: /^Planning/ });
  details.available = false;
  fireEvent.doubleClick(row);
  expect(f.open).toHaveBeenLastCalledWith(conversationTarget(scope, id));
  expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull();
});
it("keeps unread state while owned thread typing and observer working signals start and stop", () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 3, 1, 30));
  const f = fixture();
  const channel = f.session.channels
    .list()
    .channels.find((item) => item.id === id);
  if (!channel) throw new Error("Missing Planning fixture");
  Object.assign(channel, {
    lastActivityAt: Math.floor(Date.now() / 1000) - 60,
  });
  f.replaceSession();
  const row = screen.getByRole("button", { name: /^Planning/ });
  const bold = () => row.querySelector('[data-channel-unread-title="true"]');
  expect(bold()).toBeInTheDocument();
  expect(row.querySelector("time")).toHaveTextContent("1m");
  f.typing([{ channelId: id, threadRootId: root, pubkey: outsider }]);
  expect(within(row).queryByRole("img", { name: /working/ })).toBeNull();
  f.typing([{ channelId: other, pubkey: agent }]);
  expect(within(row).queryByRole("img", { name: /working/ })).toBeNull();
  f.typing([{ channelId: id, threadRootId: root, pubkey: agent }]);
  expect(
    within(row).getByRole("img", { name: "Owned Agent working in Planning" }),
  ).toBeInTheDocument();
  expect(row.querySelector("time")).toBeNull();
  expect(row).not.toHaveAttribute("aria-describedby");
  expect(bold()).toBeInTheDocument();
  expect(row).toHaveAccessibleName(/observed unread messages/);
  expect(row).toHaveAccessibleName(/Owned Agent working in Planning/);
  f.activity({
    ...f.activitySnapshot,
    status: "listening",
    turns: [
      {
        channelId: id,
        agent,
        turnId: "one",
        timestamp: Date.now(),
        state: "working",
      },
    ],
  });
  expect(row.querySelectorAll("[data-channel-working]")).toHaveLength(1);
  expect(row).not.toHaveAttribute("aria-describedby");
  f.typing([]);
  expect(within(row).getByRole("img", { name: /working/ })).toBeInTheDocument();
  f.activity(f.activitySnapshot);
  expect(within(row).queryByRole("img", { name: /working/ })).toBeNull();
  expect(row.querySelector("time")).toHaveTextContent("1m");
  expect(bold()).toBeInTheDocument();
  f.activity({
    ...f.activitySnapshot,
    local: [
      {
        scope,
        agent,
        channelId: id,
        messageId: "waiting-message",
        threadRootId: root,
        state: "waiting",
        startedAt: Date.now(),
      },
    ],
  });
  expect(
    within(row).getByRole("img", { name: "Owned Agent waiting in Planning" }),
  ).toBeInTheDocument();
  expect(row.querySelector("time")).toBeNull();
  expect(row).not.toHaveAttribute("aria-describedby");
  f.clearUnread();
  expect(row.querySelector("[data-channel-unread]")).toBeNull();
  cleanup();
  expect(f.listeners.size).toBe(0);
});
it("offers unread thread navigation and mark-read through the shared activity popover", async () => {
  const f = fixture();
  const user = userEvent.setup();
  f.threads({
    channelId: id,
    items: [
      {
        channelId: id,
        rootId: root,
        latestMessageId: "e".repeat(64),
        authorId: agent,
        preview: "Needs review",
        unreadCount: 1,
        createdAt: 1,
      },
    ],
    coverage: "observed",
    freshness: "observed",
  });
  const row = screen.getByRole("button", { name: /^Planning/ });
  row.focus();
  await user.keyboard("{Enter}");
  const popup = screen.getByRole("dialog", { name: "Activity in Planning" });
  await user.click(
    within(popup).getByRole("button", {
      name: "Mark thread from Owned Agent as read",
    }),
  );
  expect(f.markThrough).toHaveBeenCalledWith(
    { kind: "thread", channelId: id, rootId: root },
    "e".repeat(64),
  );
  await user.click(
    within(popup).getByRole("button", {
      name: "Open unread thread from Owned Agent: Needs review",
    }),
  );
  expect(f.open).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: "conversation",
      channelId: id,
      messageId: root,
    }),
  );
});
it("opens a typing-only agent's profile activity in its Solo chat", async () => {
  const f = fixture();
  f.typing([{ channelId: id, pubkey: agent }]);
  const user = userEvent.setup();
  screen.getByRole("button", { name: /^Planning/ }).focus();
  await user.keyboard("{Enter}");
  let popup = screen.getByRole("dialog", { name: "Activity in Planning" });
  await user.click(
    within(popup).getByRole("button", { name: "View Owned Agent activity" }),
  );
  expect(f.open).toHaveBeenLastCalledWith(conversationTarget(scope, id));
  screen.getByRole("button", { name: /^Planning/ }).focus();
  await user.keyboard("{Enter}");
  popup = screen.getByRole("dialog", { name: "Activity in Planning" });
  await user.click(
    within(popup).getByRole("button", {
      name: "Open conversation for Owned Agent in Planning",
    }),
  );
  expect(f.open).toHaveBeenLastCalledWith(conversationTarget(scope, id));
});

it("shows a plugin's chat icon in place of the chat bubble, from when it registers", () => {
  let icons: readonly Contribution<ChatIcon>[] = [];
  const listeners = new Set<() => void>();
  fixture(false, false, undefined, undefined, 0, {
    snapshot: () => icons,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const planning = screen.getByRole("button", { name: /^Planning/ });
  expect(planning.querySelector("[aria-hidden] svg")).not.toBeNull();
  act(() => {
    icons = [
      {
        id: "chat-icon",
        key: "github/chat-icon",
        pluginId: "github",
        revision: "one",
        component: ({ channelId, fallback }) =>
          channelId === id ? (
            <span data-testid="pull">Pull request, merged: </span>
          ) : (
            fallback
          ),
      },
    ];
    for (const listener of listeners) listener();
  });
  expect(within(planning).getByTestId("pull")).toBeInTheDocument();
  expect(planning).toHaveAccessibleName(/^Pull request, merged:\s*Planning/);
  // A chat the plugin knows nothing about keeps its bubble.
  const otherRow = screen.getByRole("button", { name: /^Other/ });
  expect(otherRow.querySelector("[aria-hidden] svg")).not.toBeNull();
});
it.each([
  { observedCount: 1, attentionCount: 1 },
  { observedCount: 1, attentionCount: 0 },
])(
  "bolds a Solo chat for any unread message, without an attention dot ($observedCount unread, $attentionCount attention)",
  (counts) => {
    const f = fixture(false, false, undefined, counts);
    const row = screen.getByRole("button", { name: /^Planning/ });
    expect(
      row.querySelector('[data-channel-unread-title="true"]'),
    ).toBeInTheDocument();
    expect(row.querySelector("[data-channel-priority]")).toBeNull();
    f.clearUnread();
    expect(row.querySelector('[data-channel-unread-title="true"]')).toBeNull();
  },
);

it.each(["new", "linked", "agent"])(
  "shows and selects the ordinary New chat draft row for %s",
  async (route) => {
    const f = fixture();
    writeView(scope, "solo:collapsed-projects", [""]);
    const target = soloDraftTarget(
      scope,
      route === "agent"
        ? { agent }
        : route === "linked"
          ? { linked: "33333333-3333-4333-8333-333333333333" }
          : {},
    );
    act(() => f.navigate(target));
    const draft = await screen.findByRole("button", { name: "New chat" });
    expect(draft).toHaveAttribute("aria-current", "page");
    expect(draft).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("button", { name: /^Other/ })).not.toHaveAttribute(
      "aria-current",
    );
    await userEvent.click(draft);
    expect(f.open).toHaveBeenLastCalledWith(target);
    act(() => f.navigate(conversationTarget(scope, id)));
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Planning/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  },
);

it("keeps the open, unread and working chats listed past a workspace's cap", () => {
  const f = fixture(false, false, undefined, undefined, 10);
  const listed = () =>
    screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("data-solo-channel-id"))
      .filter(Boolean);
  // Seven newest, then unread Planning and open Other past the cap, in order.
  expect(listed()).toEqual([
    ...Array.from({ length: 7 }, (_, index) => `newer-${index}`),
    id,
    other,
  ]);
  // Reading it does not pull the row away; it stays until the workspace folds.
  f.clearUnread();
  expect(listed()).toContain(id);
  f.activity({
    ...f.activitySnapshot,
    status: "listening",
    turns: [
      {
        channelId: "newer-9",
        agent,
        turnId: "one",
        timestamp: Date.now(),
        state: "working",
      },
    ],
  });
  expect(listed()).toContain("newer-9");
  expect(listed()).not.toContain("newer-8");
});

it.each([
  [0, "now", "just now"],
  [59, "now", "just now"],
  [60, "1m", "1 minute ago"],
  [3_599, "59m", "59 minutes ago"],
  [3_600, "1h", "1 hour ago"],
  [86_399, "23h", "23 hours ago"],
  [86_400, "1d", "1 day ago"],
] as const)(
  "shows an accessible compact age at the %s-second boundary",
  (age, compact, spoken) => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 10, 3, 1, 30);
    vi.setSystemTime(now);
    const f = fixture();
    const channel = f.session.channels
      .list()
      .channels.find((item) => item.id === id);
    if (!channel) throw new Error("Missing Planning fixture");
    const timestamp = now / 1000 - age;
    Object.assign(channel, { lastActivityAt: timestamp });
    f.navigate(conversationTarget(scope, other));

    const row = screen.getByRole("button", { name: /^Planning/ });
    const time = row.querySelector("time");
    expect(time).toHaveTextContent(compact);
    expect(time).toHaveAttribute(
      "dateTime",
      new Date(timestamp * 1000).toISOString(),
    );
    expect(row).toHaveAccessibleName(/^Planning/);
    expect(row).not.toHaveAccessibleName(/(?:Active|Updated) .+ ago/);
    expect(row).toHaveAccessibleDescription(`Active ${spoken}`);
    expect(row.getAttribute("aria-describedby")?.split(" ")).toEqual([
      `solo-activity-age-${id}`,
    ]);
  },
);

it("refreshes mounted ages, resumes after sleep, and releases its shared clock", () => {
  vi.useFakeTimers();
  const now = Date.UTC(2026, 10, 3, 1, 30);
  vi.setSystemTime(now);
  const focusAdd = vi.spyOn(window, "addEventListener");
  const focusRemove = vi.spyOn(window, "removeEventListener");
  const visibilityAdd = vi.spyOn(document, "addEventListener");
  const visibilityRemove = vi.spyOn(document, "removeEventListener");
  const f = fixture(false, false, undefined, undefined, 2);
  const timersBeforeAgeSubscriptions = vi.getTimerCount();
  const channels = f.session.channels.list().channels;
  const planning = channels.find((item) => item.id === id);
  const otherChannel = channels.find((item) => item.id === other);
  if (!planning || !otherChannel) throw new Error("Missing Solo fixtures");
  Object.assign(planning, { lastActivityAt: now / 1000 - 59 });
  Object.assign(otherChannel, { lastActivityAt: now / 1000 - 3_599 });
  f.navigate(conversationTarget(scope, other));
  const row = screen.getByRole("button", { name: /^Planning/ });
  const otherRow = screen.getByRole("button", { name: /^Other/ });
  const listed = () =>
    screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("data-solo-channel-id"))
      .filter(Boolean);
  const order = listed();
  row.focus();
  fireEvent.pointerEnter(row, { pointerType: "mouse" });
  expect(row.querySelector("time")).toHaveTextContent("now");
  expect(otherRow.querySelector("time")).toHaveTextContent("59m");
  expect(vi.getTimerCount()).toBe(timersBeforeAgeSubscriptions + 1);

  act(() => vi.advanceTimersByTime(1_000));
  expect(row.querySelector("time")).toHaveTextContent("1m");
  expect(otherRow.querySelector("time")).toHaveTextContent("1h");
  expect(screen.getByRole("button", { name: /^Planning/ })).toBe(row);
  expect(row).toHaveFocus();
  expect(listed()).toEqual(order);

  vi.setSystemTime(now + 3 * 60 * 60 * 1000);
  expect(row.querySelector("time")).toHaveTextContent("1m");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(row.querySelector("time")).toHaveTextContent("3h");
  expect(otherRow.querySelector("time")).toHaveTextContent("3h");
  expect(row).toHaveFocus();
  expect(listed()).toEqual(order);

  vi.setSystemTime(now + 4 * 60 * 60 * 1000);
  act(() => window.dispatchEvent(new Event("focus")));
  expect(row.querySelector("time")).toHaveTextContent("4h");
  expect(row).toHaveAccessibleDescription("Active 4 hours ago");
  expect(listed()).toEqual(order);

  const focusListeners = focusAdd.mock.calls
    .filter(([type]) => type === "focus")
    .map(([, listener]) => listener);
  const visibilityListeners = visibilityAdd.mock.calls
    .filter(([type]) => type === "visibilitychange")
    .map(([, listener]) => listener);
  expect(focusListeners).toHaveLength(1);
  expect(visibilityListeners).toHaveLength(1);
  cleanup();
  expect(vi.getTimerCount()).toBe(0);
  for (const listener of focusListeners)
    expect(focusRemove).toHaveBeenCalledWith("focus", listener);
  for (const listener of visibilityListeners)
    expect(visibilityRemove).toHaveBeenCalledWith("visibilitychange", listener);

  const remounted = fixture();
  const timersBeforeRemount = vi.getTimerCount();
  const remountedChannel = remounted.session.channels
    .list()
    .channels.find((item) => item.id === id);
  if (!remountedChannel) throw new Error("Missing remount fixture");
  Object.assign(remountedChannel, {
    lastActivityAt: Math.floor(Date.now() / 1000) - 60,
  });
  remounted.navigate(conversationTarget(scope, other));
  expect(
    screen.getByRole("button", { name: /^Planning/ }).querySelector("time"),
  ).toHaveTextContent("1m");
  expect(vi.getTimerCount()).toBe(timersBeforeRemount + 1);
  cleanup();
  expect(vi.getTimerCount()).toBe(timersBeforeRemount);
});

it("uses only the selected nullish sort timestamp and composes shared descriptions", () => {
  vi.useFakeTimers();
  const now = Date.UTC(2026, 10, 3, 1, 30);
  vi.setSystemTime(now);
  const f = fixture();
  const channel = f.session.channels
    .list()
    .channels.find((item) => item.id === id);
  if (!channel) throw new Error("Missing Planning fixture");
  const human = "e".repeat(64);
  (f.session.profiles.snapshot() as Map<string, Profile>).set(human, {
    name: "Person",
  });
  Object.assign(channel, {
    members: [human],
    updatedAt: now / 1000 - 3_600,
  });
  f.navigate(conversationTarget(scope, other));

  const row = screen.getByRole("button", { name: /^Planning/ });
  expect(row.querySelector("time")).toHaveTextContent("1h");
  expect(row).toHaveAccessibleDescription("Shared Updated 1 hour ago");
  expect(row.getAttribute("aria-describedby")?.split(" ")).toEqual([
    `solo-shared-${id}`,
    `solo-activity-age-${id}`,
  ]);
  expect(document.querySelectorAll(`#solo-shared-${id}`)).toHaveLength(1);
  expect(document.querySelectorAll(`#solo-activity-age-${id}`)).toHaveLength(1);

  vi.setSystemTime(now + 60 * 60 * 1000);
  act(() => window.dispatchEvent(new Event("focus")));
  expect(row).toHaveAccessibleDescription("Shared Updated 2 hours ago");
  expect(row.getAttribute("aria-describedby")?.split(" ")).toEqual([
    `solo-shared-${id}`,
    `solo-activity-age-${id}`,
  ]);
  expect(document.querySelectorAll(`#solo-shared-${id}`)).toHaveLength(1);
  expect(document.querySelectorAll(`#solo-activity-age-${id}`)).toHaveLength(1);

  for (const invalid of [0, Number.NaN, Number.POSITIVE_INFINITY, 1e300]) {
    Object.assign(channel, { lastActivityAt: invalid });
    f.navigate(conversationTarget(scope, other));
    expect(row.querySelector("time")).toBeNull();
    expect(row.getAttribute("aria-describedby")).toBe(`solo-shared-${id}`);
    expect(row).toHaveAccessibleDescription("Shared");
  }

  Object.assign(channel, { lastActivityAt: now / 1000 + 3_600 });
  f.navigate(conversationTarget(scope, other));
  expect(row.querySelector("time")).toHaveTextContent("now");
  expect(row).toHaveAccessibleDescription("Shared Active just now");

  Object.assign(channel, { lastActivityAt: undefined, updatedAt: undefined });
  f.navigate(conversationTarget(scope, other));
  expect(row.querySelector("time")).toBeNull();
  expect(row.getAttribute("aria-describedby")).toBe(`solo-shared-${id}`);
});

it("describes a Solo row as Shared only when its Shared mark renders", () => {
  fixture();
  expect(screen.getByRole("button", { name: /^Planning/ })).not.toHaveAttribute(
    "aria-describedby",
  );
});

it("shows plugin actions in the primary sidebar right-click menu", async () => {
  const { MenuItem } = await import("../../shared/design-system/ui/Menu");
  const menus: Contribution<ChatMenu>[] = [
    {
      id: "test-menu",
      key: "test/menu",
      pluginId: "test",
      revision: "1",
      component: ({ channelId }) =>
        channelId === id ? <MenuItem>Unlink pull request</MenuItem> : null,
    },
  ];
  fixture(true, false, undefined, undefined, 0, undefined, {
    snapshot: () => menus,
    subscribe: () => () => {},
  });
  fireEvent.keyDown(screen.getByRole("button", { name: /^Planning/ }), {
    key: "ContextMenu",
  });
  expect(
    await screen.findByRole("menuitem", { name: "Unlink pull request" }),
  ).toBeVisible();
});
