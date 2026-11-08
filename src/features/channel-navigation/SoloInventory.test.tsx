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
import type {
  RegisteredSidebarRows,
  SidebarRow,
  SidebarRowContribution,
  SidebarRows,
} from "./sidebar-rows-service";

import {
  fixture,
  owners,
  id,
  other,
  agent,
  outsider,
  root,
  scope,
  viewer,
} from "../../app/shell/sidebar-testing";
stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.unstubAllGlobals();
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
  const f = fixture();
  const row = screen.getByRole("button", { name: /^Planning/ });
  const bold = () => row.querySelector('[data-channel-unread-title="true"]');
  expect(bold()).toBeInTheDocument();
  f.typing([{ channelId: id, threadRootId: root, pubkey: outsider }]);
  expect(within(row).queryByRole("img", { name: /working/ })).toBeNull();
  f.typing([{ channelId: other, pubkey: agent }]);
  expect(within(row).queryByRole("img", { name: /working/ })).toBeNull();
  f.typing([{ channelId: id, threadRootId: root, pubkey: agent }]);
  expect(
    within(row).getByRole("img", { name: "Owned Agent working in Planning" }),
  ).toBeInTheDocument();
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
  f.typing([]);
  expect(within(row).getByRole("img", { name: /working/ })).toBeInTheDocument();
  f.activity(f.activitySnapshot);
  expect(within(row).queryByRole("img", { name: /working/ })).toBeNull();
  expect(bold()).toBeInTheDocument();
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
  let intent: unknown;
  const navigate = f.open.getMockImplementation();
  f.open.mockImplementationOnce(async (next) => {
    intent = f.handoff()?.activityAgent.current;
    if (!navigate) throw new Error("Missing navigator");
    return navigate(next);
  });
  await user.click(
    within(popup).getByRole("button", { name: "View Owned Agent activity" }),
  );
  expect(f.open).toHaveBeenLastCalledWith(conversationTarget(scope, id));
  // A Solo chat is one conversation, so its page opens the transcript.
  expect(intent).toMatchObject({ channelId: id, agent });
  expect(intent).toHaveProperty("transcript", {});
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

it("renders again only the Solo row whose chat changed", () => {
  const renders = new Map<string, number>();
  const icons: readonly Contribution<ChatIcon>[] = [
    {
      id: "render-count",
      key: "test/render-count",
      pluginId: "test",
      revision: "one",
      component: ({ channelId, fallback }) => {
        renders.set(channelId, (renders.get(channelId) ?? 0) + 1);
        return fallback;
      },
    },
  ];
  const f = fixture(false, false, undefined, undefined, 0, {
    snapshot: () => icons,
    subscribe: () => () => {},
  });
  expect(renders.get(id)).toBeGreaterThan(0);
  renders.clear();
  f.roster((channels) =>
    channels.map((channel) =>
      channel.id === other ? { ...channel, name: "Renamed" } : channel,
    ),
  );
  expect(screen.getByRole("button", { name: /^Renamed/ })).toBeInTheDocument();
  expect(renders.get(other)).toBeGreaterThan(0);
  // Planning's chat did not change, so its row did not render again.
  expect(renders.has(id)).toBe(false);
});

it("renames and opens settings for a chat the roster delivers after mount", async () => {
  const f = fixture();
  Object.assign(f.session, {
    channelDetails: {
      ...f.session.channelDetails,
      available: true,
      load: vi.fn(async (channelId: string) => ({
        channelId,
        name: "Fresh",
        description: "",
        visibility: "private",
        labels: ["buzz.solo"],
        canEdit: true,
        version: "one",
      })),
    },
  });
  f.replaceSession();
  f.roster((channels) => [
    ...channels,
    { id: "fresh", name: "Fresh", channelType: "solo", creator: viewer },
  ]);
  const user = userEvent.setup();
  // Rows read their actions when used: a row added after mount must reach
  // the actions of the current render, not those of the first one.
  await user.click(
    await screen.findByRole("button", { name: "Actions for Fresh" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
  expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue(
    "Fresh",
  );
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Actions for Fresh" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Chat settings" }),
  );
  expect(await screen.findByRole("dialog")).toBeVisible();
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

const registered = (
  contribution: Partial<SidebarRowContribution>,
): SidebarRows => {
  const entries = [
    {
      id: "rows",
      key: "test/rows",
      pluginId: "test",
      revision: "1",
      version: 1,
      ...contribution,
    },
  ] as unknown as readonly RegisteredSidebarRows[];
  return {
    version: 1,
    snapshot: () => entries,
    subscribe: () => () => {},
    register: () => {},
  };
};
const withRows = (contribution: Partial<SidebarRowContribution>) => {
  const f = fixture(
    false,
    false,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    { sidebarRows: registered(contribution) },
  );
  return {
    ...f,
    work() {
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
    },
  };
};
const rowIds = () =>
  Array.from(document.querySelectorAll("[data-solo-channel-id]")).map((row) =>
    row.getAttribute("data-solo-channel-id"),
  );

it("keeps Solo order and DOM unchanged without contributions", () => {
  fixture();
  const expected = rowIds();
  const stable = () =>
    document.body.innerHTML.replace(/(base-ui-_r_|Dnd\w+-)\w+/g, "$1");
  const html = stable();
  cleanup();
  fixture(false, false, undefined, undefined, 0, undefined, undefined, {
    sidebarRows: registered({}),
  });
  expect(rowIds()).toEqual(expected);
  expect(stable()).toBe(html);
  expect(document.querySelector("[data-solo-group]")).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Actions for Chats/ }),
  ).toBeNull();
});

it("decorates Solo rows, falls back when a renderer throws and hides on null", () => {
  withRows({
    render: (row, Default) =>
      row.kind === "solo" && row.id === id ? (
        <div data-decorated={String(row.working)}>{Default}</div>
      ) : (
        Default
      ),
  });
  expect(document.querySelector("[data-decorated]")).toHaveAttribute(
    "data-decorated",
    "false",
  );
  expect(rowIds()).toEqual([id, other]);
  cleanup();
  withRows({
    render: () => {
      throw new Error("boom");
    },
  });
  expect(rowIds()).toEqual([id, other]);
  cleanup();
  withRows({ render: (row, Default) => (row.id === id ? null : Default) });
  expect(rowIds()).toEqual([other]);
});

it("offers plugin sort modes in the Chats menu and remembers the choice", async () => {
  const user = userEvent.setup();
  const modes = {
    sortModes: [
      {
        id: "other-first",
        label: "Other first",
        compare: (a: SidebarRow, b: SidebarRow) =>
          Number(b.id === other) - Number(a.id === other),
      },
    ],
  };
  withRows(modes);
  expect(rowIds()).toEqual([id, other]);
  await user.click(screen.getByRole("button", { name: "Actions for Chats" }));
  await user.click(await screen.findByRole("menuitem", { name: "Sort" }));
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Other first" }),
  );
  expect(rowIds()).toEqual([other, id]);
  cleanup();
  withRows(modes);
  expect(rowIds()).toEqual([other, id]);
  cleanup();
  withRows({});
  expect(rowIds()).toEqual([id, other]);
});

it("collapses grouped Solo chats, persists the open state and keeps the selected group open", async () => {
  const user = userEvent.setup();
  const group = {
    group: (row: SidebarRow) =>
      row.working ? { id: "working", label: "1 working" } : null,
  };
  const f = withRows(group);
  expect(document.querySelector("[data-solo-group]")).toBeNull();
  f.work();
  const header = screen.getByRole("button", { name: /1 working/ });
  expect(header).toHaveAttribute("aria-expanded", "false");
  expect(rowIds()).toEqual([other]);
  await user.click(header);
  expect(header).toHaveAttribute("aria-expanded", "true");
  expect(rowIds()).toEqual([id, other]);
  cleanup();
  const again = withRows(group);
  again.work();
  expect(screen.getByRole("button", { name: /1 working/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  cleanup();
  localStorage.clear();
  withRows({
    group: (row: SidebarRow) =>
      row.id === other ? { id: "open", label: "Open" } : null,
  });
  expect(screen.getByRole("button", { name: /Open/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(rowIds()).toContain(other);
});

it("ignores a saved sort when no plugin offers sort modes", () => {
  writeView(scope, "solo:sort", { "": "alpha" });
  fixture();
  expect(rowIds()).toEqual([id, other]);
});

it("keeps grouped chats out of Show more and Show less", () => {
  fixture(false, false, undefined, undefined, 9, undefined, undefined, {
    sidebarRows: registered({
      group: (row: SidebarRow) =>
        row.id.startsWith("newer-") ? { id: "newer", label: "Newer" } : null,
    }),
  });
  expect(screen.getByRole("button", { name: "Newer" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(document.querySelector("[data-solo-show-more]")).toBeNull();
});

it("drops a group heading when every member is hidden", () => {
  withRows({
    group: (row: SidebarRow) =>
      row.id === other ? { id: "open", label: "Open" } : null,
    render: (row: SidebarRow, Default) => (row.id === other ? null : Default),
  });
  expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  expect(rowIds()).toEqual([id]);
});
