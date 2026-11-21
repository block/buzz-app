// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { formatPublicKey } from "../../shared/identity/public-key";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { setThreadPlacementPreference } from "../../features/messages/thread-preferences";
import type { RelaySession } from "../../features/relay/session";
import { createNavigationController } from "../../features/navigation/controller";
import { createBrowserHistory } from "../../features/navigation/browser-history";
import {
  createMemoryHistory,
  type NavigationHistory,
} from "../../features/navigation/history";
import type { JsonValue, OpenTarget } from "../../features/navigation/targets";
import { pageTabRoute } from "./page-tab-route";
import type { ConversationTab as Tab } from "./useChannelTabState";
import {
  ConversationWorkspace,
  PageTabs,
  type PageTabOptions,
  type PageTabTarget,
} from "./PageTabs";

// The tab's own conversation has its mounted suite; this owner places it.
vi.mock("./ConversationTab", () => ({
  ConversationTab: ({
    tab,
    channel,
    visit,
    onResolvedRoot,
    parent,
    intro,
    openLink,
  }: {
    intro?: import("react").ReactNode;
    openLink?: (url: string, origin?: { rootId?: string }) => boolean;
    tab: Tab;
    channel: { name: string };
    visit: boolean;
    onResolvedRoot?: (rootId: string) => void;
    parent?: { label: string; open(): void };
  }) => (
    <p
      data-tab={tab.id}
      data-message={tab.messageId}
      data-reveal={tab.revealRequest}
      data-mark-read={tab.kind === "conversation" ? tab.markRead : undefined}
      data-focus={tab.focusRequest}
      data-reply={tab.kind === "thread" ? tab.replyRequest : undefined}
    >
      {intro}
      {tab.kind} in {channel.name}
      {!visit && " unvisited"}
      {onResolvedRoot && (
        <button type="button" onClick={() => onResolvedRoot("older")}>
          Resolve root
        </button>
      )}
      {parent && (
        <button type="button" onClick={parent.open}>
          {parent.label}
        </button>
      )}
      {openLink && (
        <button
          type="button"
          onClick={() =>
            openLink(
              "https://github.com/block/buzz/pull/1",
              tab.kind === "thread" ? { rootId: "root" } : undefined,
            )
          }
        >
          Open pull request
        </button>
      )}
    </p>
  ),
}));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const switchboard: OpenTarget = {
  version: 1,
  kind: "page",
  pluginId: "buzz.test",
  pageId: "switchboard",
};

function fixture(
  visits?: boolean,
  history?: "tabs",
  initial: OpenTarget = switchboard,
  driver: NavigationHistory = createMemoryHistory(initial),
) {
  const channels = [
    { id: "alpha", name: "alpha" },
    { id: "beta", name: "beta" },
    { id: "pending", name: "pending", cached: true },
    { id: "dm", name: "Alice", channelType: "dm" },
    {
      id: "group",
      name: "Everyone",
      channelType: "dm",
      participants: ["a", "b", "e", "z"].map((c) => c.repeat(64)),
    },
  ];
  const list = { channels };
  const rows = { rows: [{ id: "root", content: "Root text" }] };
  const profiles = new Map([
    ["a".repeat(64), { name: "Ann" }],
    ["b".repeat(64), { name: "Bob" }],
    ["z".repeat(64), { name: "Zed" }],
  ]);
  const github = {
    key: "buzz.github/object",
    id: "object",
    title: "GitHub",
    matches: (target: string) => target.startsWith("https://github.com/"),
    component: () => <p>Pull request</p>,
  };
  const available = history ? [github] : [];
  const session = {
    viewer: "viewer",
    channels: {
      ensureList: () => () => {},
      subscribeList: () => () => {},
      list: () => list,
      window: () => rows,
    },
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: () => Promise.resolve(),
    },
  } as unknown as RelaySession;
  const connection = { status: "ready", session, scope: "origin:viewer" };
  const host = {
    relay: { snapshot: () => connection },
    panels: {
      snapshot: () => available,
      subscribe: () => () => {},
      resolve: (target: string) =>
        available.find((panel) => panel.matches(target)),
      handleOpenRequests: () => () => {},
    },
    navigation: history
      ? createNavigationController(driver).navigation
      : {
          open: vi.fn(),
          snapshot: () => ({
            entry: { id: "home", target: { version: 1, kind: "home" } },
          }),
          subscribe: () => () => {},
        },
    pages: {
      snapshot: () => [
        {
          key: "buzz.test/switchboard",
          route: {
            version: 1,
            validate: (params: JsonValue) => !!pageTabRoute(params),
          },
        },
      ],
      subscribe: () => () => {},
    },
  } as unknown as ConversationHostServices;
  let open: (target: PageTabTarget, options?: PageTabOptions) => boolean = () =>
    false;
  let close: (target: PageTabTarget) => boolean = () => false;
  let isOpen: (target: PageTabTarget) => boolean = () => false;
  const openers = new Set<typeof open>();
  render(
    <PageTabs
      id="switchboard"
      session={session}
      scope="origin:viewer"
      label="Switchboard"
      host={host}
      extensions={{} as ConversationExtensions}
      visits={visits}
    >
      {(next, closer, opened) => {
        open = next;
        close = closer;
        isOpen = opened;
        openers.add(next);
        return <p>Chat list</p>;
      }}
    </PageTabs>,
  );
  return {
    host,
    session,
    openers,
    navigation: host.navigation,
    open(target: PageTabTarget, options?: PageTabOptions) {
      let opened = false;
      act(() => {
        opened = open(target, options);
      });
      return opened;
    },
    isOpen: (target: PageTabTarget) => isOpen(target),
    close(target: PageTabTarget) {
      let closed = false;
      act(() => {
        closed = close(target);
      });
      return closed;
    },
  };
}
const tabs = (name: string) =>
  within(screen.getByRole("tablist", { name }))
    .getAllByRole("tab")
    .map((tab) => tab.textContent);

const side = () => {
  const list = screen
    .getAllByRole("tablist")
    .find((item) => item.getAttribute("aria-label") !== "Switchboard tabs");
  return within(list as HTMLElement)
    .getAllByRole("tab")
    .map((tab) => tab.textContent);
};

it("keeps the page in view, opening threads in the side pane", () => {
  setThreadPlacementPreference("main");
  const page = fixture();
  expect(screen.getByText("Chat list")).toBeVisible();
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(tabs("Switchboard tabs")).toEqual(["Switchboard"]);
  expect(side()).toEqual(["Root text"]);
  expect(screen.getByText("Chat list")).toBeVisible();
  expect(screen.getByText("thread in alpha")).toBeVisible();
});

it("replaces the last opened tab unless asked to keep it", () => {
  const page = fixture();
  expect(page.open({ channelId: "missing" })).toBe(false);
  // Membership a cached channel has not confirmed cannot show a tab.
  expect(page.open({ channelId: "pending" })).toBe(false);
  expect(page.open({ channelId: "beta" })).toBe(true);
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(side()).toEqual(["Root text"]);
  expect(page.open({ channelId: "beta" }, { keep: true })).toBe(true);
  expect(page.open({ channelId: "alpha" })).toBe(true);
  expect(side()).toEqual(["beta", "alpha"]);
  // Opening a kept tab's conversation again selects it in place.
  expect(page.open({ channelId: "beta" })).toBe(true);
  expect(side()).toEqual(["beta", "alpha"]);
  expect(screen.getByText("conversation in beta")).toBeVisible();
  // Pages can depend on one opener across the renders its tabs cause.
  expect(page.openers.size).toBe(1);
});

it("gives each conversation tab its sidebar icon", () => {
  const page = fixture();
  expect(page.open({ channelId: "beta" })).toBe(true);
  expect(page.open({ channelId: "dm" }, { keep: true })).toBe(true);
  const list = screen
    .getAllByRole("tablist")
    .find((item) => item.getAttribute("aria-label") !== "Switchboard tabs");
  expect(
    within(list as HTMLElement)
      .getAllByRole("tab")
      .map(
        (tab) =>
          `${
            tab
              .querySelector("svg")
              ?.getAttribute("class")
              ?.match(/tabler-icon-[\w-]+/)?.[0]
          } ${tab.textContent}`,
      ),
  ).toEqual(["tabler-icon-hash beta", "tabler-icon-message-circle Alice"]);
});

it("opens a thread moved to the main pane where it is", () => {
  const page = fixture();
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  act(() => {
    fireEvent.keyDown(screen.getByRole("tab", { name: /Root text/ }), {
      key: "ArrowLeft",
      altKey: true,
      shiftKey: true,
    });
  });
  expect(tabs("Switchboard tabs")).toEqual(["Switchboard", "Root text"]);
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(tabs("Switchboard tabs")).toEqual(["Switchboard", "Root text"]);
  // The next plain open does not replace it.
  expect(page.open({ channelId: "beta" })).toBe(true);
  expect(tabs("Switchboard tabs")).toEqual(["Switchboard", "Root text"]);
  expect(side()).toEqual(["beta"]);
});

it("opens at a message, asking again on each open, with the page's read choice", () => {
  const page = fixture();
  expect(
    page.open({ channelId: "beta", messageId: "post" }, { markRead: false }),
  ).toBe(true);
  const tab = () => screen.getByText("conversation in beta");
  expect(tab()).toHaveAttribute("data-message", "post");
  expect(tab()).toHaveAttribute("data-reveal", "1");
  expect(tab()).toHaveAttribute("data-mark-read", "false");
  // The same message again reveals it again; a later open sets the read choice.
  page.open({ channelId: "beta", messageId: "post" }, { markRead: false });
  expect(tab()).toHaveAttribute("data-reveal", "2");
  page.open({ channelId: "beta" });
  expect(tab()).not.toHaveAttribute("data-message");
  expect(tab()).not.toHaveAttribute("data-mark-read");
  expect(side()).toEqual(["beta"]);
});

it("opens a thread at one of its messages", () => {
  const page = fixture();
  page.open({ channelId: "alpha", threadId: "root", messageId: "reply" });
  const thread = () => screen.getByText("thread in alpha");
  expect(thread()).toHaveAttribute("data-message", "reply");
  expect(thread()).toHaveAttribute("data-reveal", "1");
  // Each open at a message asks the reader to show it again.
  page.open({ channelId: "alpha", threadId: "root", messageId: "reply" });
  expect(thread()).toHaveAttribute("data-reveal", "2");
  // Opening the thread itself asks for no reveal.
  page.open({ channelId: "alpha", threadId: "root" });
  expect(thread()).toHaveAttribute("data-message", "root");
  expect(thread()).toHaveAttribute("data-reveal", "2");
});

it("reopens a thread opened at a reply in its tab once its root resolves", () => {
  const page = fixture();
  page.open({ channelId: "alpha", threadId: "reply" });
  const thread = () => screen.getByText("thread in alpha");
  const id = thread().getAttribute("data-tab");
  fireEvent.click(screen.getByRole("button", { name: "Resolve root" }));
  expect(
    page.open({ channelId: "alpha", threadId: "reply", messageId: "reply" }),
  ).toBe(true);
  expect(thread()).toHaveAttribute("data-tab", id);
  expect(thread()).toHaveAttribute("data-reveal", "1");
  expect(page.isOpen({ channelId: "alpha", threadId: "older" })).toBe(true);
});

it("opens a page's tabs without visiting their conversations when it asks", () => {
  const page = fixture(false);
  expect(
    page.open({ channelId: "alpha", threadId: "root", messageId: "reply" }),
  ).toBe(true);
  expect(screen.getByText("thread in alpha unvisited")).toHaveAttribute(
    "data-message",
    "reply",
  );
  expect(page.open({ channelId: "beta" })).toBe(true);
  expect(screen.getByText("conversation in beta unvisited")).toBeVisible();
});

it("closes a conversation's tab only when one is open", () => {
  const page = fixture();
  expect(page.close({ channelId: "alpha", threadId: "root" })).toBe(false);
  expect(page.open({ channelId: "beta" }, { keep: true })).toBe(true);
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(page.isOpen({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(page.close({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(page.isOpen({ channelId: "alpha", threadId: "root" })).toBe(false);
  expect(side()).toEqual(["beta"]);
  expect(page.close({ channelId: "beta" })).toBe(true);
  expect(screen.getAllByRole("tablist")).toHaveLength(1);
});

it("focuses the composer of each tab it opens, except at a message", () => {
  const page = fixture();
  const tab = () => screen.getByText("conversation in beta");
  const thread = () => screen.getByText("thread in alpha");
  page.open({ channelId: "beta" });
  expect(tab()).toHaveAttribute("data-focus", "1");
  page.open({ channelId: "beta" });
  expect(tab()).toHaveAttribute("data-focus", "2");
  page.open({ channelId: "beta", messageId: "post" });
  expect(tab()).toHaveAttribute("data-focus", "2");
  page.open({ channelId: "alpha", threadId: "root" }, { keep: true });
  expect(thread()).toHaveAttribute("data-focus", "1");
  page.open({ channelId: "alpha", threadId: "root", messageId: "reply" });
  expect(thread()).toHaveAttribute("data-focus", "1");
  page.open({ channelId: "alpha", threadId: "root" });
  expect(thread()).toHaveAttribute("data-focus", "2");
  // Focus is not a Reply, which would retarget the reply box at the root.
  expect(thread()).not.toHaveAttribute("data-reply");
});

it("names a thread's conversation inside it, linking where the menu's Open in channel goes", async () => {
  const user = userEvent.setup();
  const page = fixture();
  page.open({ channelId: "alpha", threadId: "root", messageId: "reply" });
  await user.click(screen.getByRole("button", { name: "#alpha" }));
  expect(page.navigation.open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "conversation",
    scope: { viewer: "viewer", communityOrigin: "origin" },
    channelId: "alpha",
    messageId: "reply",
    threadRootId: "root",
    context: "channel",
  });
  page.open({ channelId: "dm", threadId: "root" });
  expect(screen.getByRole("button", { name: "DM · Alice" })).toBeVisible();
  // A group DM's caption bounds its names as Inbox rows do; its tab lists all.
  page.open({ channelId: "group", threadId: "root" });
  expect(
    screen.getByRole("button", {
      name: `DM · Ann, Bob, ${formatPublicKey("e".repeat(64))} +1`,
    }),
  ).toBeVisible();
  expect(screen.getByRole("tab", { name: "Root text" })).toBeVisible();
});

it("opens a tab's conversation in its channel from the tab's menu", async () => {
  const user = userEvent.setup();
  const page = fixture();
  page.open({ channelId: "alpha", threadId: "root", messageId: "reply" });
  const scope = { viewer: "viewer", communityOrigin: "origin" };
  // The menu has handed focus back to the tab, so the destination can take it.
  let focused: Element | null = null;
  vi.mocked(page.navigation.open).mockImplementation(async () => {
    focused = document.activeElement;
    return { status: "opened" };
  });
  const thread = screen.getByRole("tab", { name: /Root text/ });
  await user.pointer({ keys: "[MouseRight]", target: thread });
  await user.click(
    await screen.findByRole("menuitem", { name: "Open in channel" }),
  );
  await vi.waitFor(() => expect(focused).toBe(thread));
  expect(page.navigation.open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "alpha",
    messageId: "reply",
    threadRootId: "root",
    context: "channel",
  });
  page.open({ channelId: "beta" });
  await user.pointer({
    keys: "[MouseRight]",
    target: screen.getByRole("tab", { name: /beta/ }),
  });
  await user.click(
    await screen.findByRole("menuitem", { name: "Open in channel" }),
  );
  await vi.waitFor(() =>
    expect(page.navigation.open).toHaveBeenLastCalledWith({
      version: 1,
      kind: "conversation",
      scope,
      channelId: "beta",
    }),
  );
});

it("a workspace owns its main reader, intro, menu, and no initial detail", async () => {
  const user = userEvent.setup();
  const f = fixture();
  cleanup();
  const source = vi.fn();
  render(
    <ConversationWorkspace
      id="task"
      session={f.session}
      scope="origin:viewer"
      target={{ channelId: "alpha", threadId: "root" }}
      label="Task"
      host={f.host}
      intro={<a href="buzz://channel/alpha">Source channel: #alpha</a>}
      actions={[{ label: "View in source channel", run: source }]}
    />,
  );
  expect(screen.queryByText("Chat list")).toBeNull();
  expect(screen.getByText("thread in alpha", { exact: false })).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Source channel: #alpha" }),
  ).toBeVisible();
  expect(screen.queryAllByRole("tablist")).toHaveLength(1);
  await user.click(
    screen.getByRole("button", { name: "Conversation actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "View in source channel" }),
  );
  expect(source).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "a workspace requests composer focus unless another editor owns it (editing=%s)",
  (editing) => {
    const f = fixture();
    cleanup();
    render(
      editing ? (
        <input aria-label="Chat name" />
      ) : (
        <button type="button">Open task</button>
      ),
    );
    screen.getByRole(editing ? "textbox" : "button").focus();
    render(
      <ConversationWorkspace
        id="task"
        session={f.session}
        scope="origin:viewer"
        target={{ channelId: "alpha" }}
        label="Task"
        host={f.host}
      />,
    );
    const reader = screen.getByText("conversation in alpha", { exact: false });
    if (editing) expect(reader).not.toHaveAttribute("data-focus");
    else expect(reader).toHaveAttribute("data-focus", "1");
  },
);

const traverse = (page: ReturnType<typeof fixture>, step: "back" | "forward") =>
  act(() => {
    page.navigation[step]();
  });
const paneShown = () =>
  screen
    .getAllByRole("button", { name: "Toggle tab pane" })
    .some((button) => button.getAttribute("aria-expanded") === "true");

it("returns with Back from a link's detail to the thread, then to the page as it was", async () => {
  const user = userEvent.setup();
  const page = fixture(undefined, "tabs");
  expect(page.open({ channelId: "alpha", threadId: "root" })).toBe(true);
  await user.click(screen.getByRole("button", { name: "Open pull request" }));
  expect(screen.getByRole("tab", { name: /GitHub/, selected: true })).toBe(
    screen.getByRole("tab", { name: /GitHub/ }),
  );
  traverse(page, "back");
  expect(screen.getByRole("tab", { name: /Root text/, selected: true })).toBe(
    screen.getByRole("tab", { name: /Root text/ }),
  );
  expect(page.navigation.snapshot().entry.target).toEqual({
    ...switchboard,
    route: { version: 1, params: { tab: "thread:alpha:root" } },
  });
  traverse(page, "back");
  // The page before any tab opened, its tabs still open beside it.
  expect(page.navigation.snapshot().entry.target).toEqual(switchboard);
  expect(paneShown()).toBe(false);
  expect(screen.getByRole("button", { name: "Toggle tab pane" })).toBeVisible();
  traverse(page, "forward");
  expect(paneShown()).toBe(true);
  expect(screen.getByRole("tab", { name: /Root text/, selected: true })).toBe(
    screen.getByRole("tab", { name: /Root text/ }),
  );
  traverse(page, "forward");
  expect(screen.getByRole("tab", { name: /GitHub/, selected: true })).toBe(
    screen.getByRole("tab", { name: /GitHub/ }),
  );
});

it("reopens with Back a tab a later open replaced, closing none", () => {
  const page = fixture(undefined, "tabs");
  page.open({ channelId: "alpha", messageId: "a".repeat(64) });
  page.open({ channelId: "beta" });
  expect(side()).toEqual(["beta"]);
  traverse(page, "back");
  expect(side()).toEqual(["beta", "alpha"]);
  const alpha = screen.getByText("conversation in alpha");
  expect(alpha).toBeVisible();
  // Reopened where the visit opened it.
  expect(alpha).toHaveAttribute("data-message", "a".repeat(64));
  traverse(page, "forward");
  expect(side()).toEqual(["beta", "alpha"]);
  expect(screen.getByText("conversation in beta")).toBeVisible();
  // Reopening took no visit of its own.
  traverse(page, "back");
  traverse(page, "back");
  expect(page.navigation.snapshot().entry.target).toEqual(switchboard);
});

it("retires a closed tab's visits, keeping the tab it leaves selected", async () => {
  const user = userEvent.setup();
  const page = fixture(undefined, "tabs");
  page.open({ channelId: "alpha", threadId: "root" });
  await user.click(screen.getByRole("button", { name: "Open pull request" }));
  await user.click(screen.getByRole("button", { name: /Close GitHub/ }));
  expect(screen.getByRole("tab", { name: /Root text/, selected: true })).toBe(
    screen.getByRole("tab", { name: /Root text/ }),
  );
  expect(page.navigation.snapshot().entry.target).toEqual({
    ...switchboard,
    route: { version: 1, params: { tab: "thread:alpha:root" } },
  });
  expect(page.navigation.snapshot().canGoForward).toBe(false);
  // The page's own close retires its tab's visits too.
  expect(page.close({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(page.navigation.snapshot().entry.target).toEqual(switchboard);
  expect(page.navigation.snapshot().canGoForward).toBe(false);
});

it("takes no visits for a page whose route does not name its tabs", () => {
  const page = fixture();
  page.open({ channelId: "alpha", threadId: "root" });
  page.open({ channelId: "beta" });
  expect(page.navigation.open).not.toHaveBeenCalled();
});

it("keeps an opening's choices while it takes its visit", () => {
  const page = fixture(undefined, "tabs");
  page.open({ channelId: "beta" }, { keep: true, markRead: false });
  page.open({ channelId: "alpha" });
  expect(side()).toEqual(["beta", "alpha"]);
  page.open({ channelId: "beta" }, { markRead: false });
  const beta = screen.getByText("conversation in beta");
  expect(beta).toHaveAttribute("data-mark-read", "false");
  expect(beta).toHaveAttribute("data-focus", "2");
});

it("returns a close that leaves no tab to the page's visit as it opened", () => {
  const filtered: OpenTarget = {
    ...switchboard,
    route: { version: 1, params: { activity: "dms" } },
  };
  const page = fixture(undefined, "tabs", filtered);
  expect(page.open({ channelId: "alpha" })).toBe(true);
  expect(page.close({ channelId: "alpha" })).toBe(true);
  expect(page.navigation.snapshot().entry.target).toEqual(filtered);
  expect(page.navigation.snapshot().canGoBack).toBe(false);
  expect(page.navigation.snapshot().canGoForward).toBe(false);
});

it("keeps the selection a close leaves when it returns to an earlier visit", async () => {
  const user = userEvent.setup();
  const page = fixture(undefined, "tabs");
  page.open({ channelId: "alpha", threadId: "root" });
  page.open({ channelId: "beta" }, { keep: true });
  // A click selects without the pointer drag jsdom cannot capture.
  fireEvent.click(screen.getByRole("tab", { name: /Root text/ }));
  await user.click(screen.getByRole("button", { name: "Open pull request" }));
  fireEvent.click(screen.getByRole("tab", { name: /beta/ }));
  await user.click(screen.getByRole("button", { name: /Close GitHub/ }));
  expect(page.navigation.snapshot().entry.target).toEqual({
    ...switchboard,
    route: { version: 1, params: { tab: "conversation:beta" } },
  });
  expect(screen.getByRole("tab", { name: /beta/, selected: true })).toBe(
    screen.getByRole("tab", { name: /beta/ }),
  );
});

it("names the tab a page's own close leaves shown", () => {
  const page = fixture(undefined, "tabs");
  page.open({ channelId: "alpha" }, { keep: true });
  page.open({ channelId: "alpha", threadId: "root" }, { keep: true });
  page.open({ channelId: "beta" }, { keep: true });
  expect(page.close({ channelId: "beta" })).toBe(true);
  expect(screen.getByText("conversation in alpha")).toBeVisible();
  expect(page.navigation.snapshot().entry.target).toEqual({
    ...switchboard,
    route: { version: 1, params: { tab: "conversation:alpha" } },
  });
  traverse(page, "back");
  expect(page.navigation.snapshot().entry.target).toEqual({
    ...switchboard,
    route: { version: 1, params: { tab: "thread:alpha:root" } },
  });
});

const hidePane = () => {
  for (const button of screen.getAllByRole("button", {
    name: "Toggle tab pane",
  }))
    if (button.getAttribute("aria-expanded") === "true")
      fireEvent.click(button);
};
// The production browser driver over a window whose traversals land when
// the test lets them, as a native history.go() lands a task later.
function deferredReturns() {
  const events = new EventTarget();
  const pending: number[] = [];
  const start = `#buzz=${encodeURIComponent(JSON.stringify(switchboard))}`;
  const location = { pathname: "/", search: "", hash: start };
  let entries = [{ state: null as unknown, hash: start }];
  let index = 0;
  const storage = new Map<string, string>();
  const traverse = (delta: number) => {
    if (!entries[index + delta]) return;
    index += delta;
    location.hash = entries[index]?.hash ?? "";
    events.dispatchEvent(new Event("popstate"));
    events.dispatchEvent(new Event("hashchange"));
  };
  const host = {
    location,
    history: {
      get state() {
        return entries[index]?.state;
      },
      replaceState(state: unknown, _title: string, url?: string) {
        if (url) location.hash = new URL(url, "https://app.example").hash;
        entries[index] = { state, hash: location.hash };
      },
      pushState(state: unknown, _title: string, url: string) {
        entries = entries.slice(0, index + 1);
        location.hash = new URL(url, "https://app.example").hash;
        entries.push({ state, hash: location.hash });
        index++;
      },
      back: () => pending.push(-1),
      forward: () => pending.push(1),
      go: (delta: number) => pending.push(delta),
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } as unknown as Window;
  // Land every traversal, including any a landing starts.
  const land = () =>
    act(async () => {
      for (let turn = 0; pending.length && turn < 10; turn++) {
        for (const delta of pending.splice(0)) traverse(delta);
        await Promise.resolve();
      }
    });
  return { driver: createBrowserHistory(host), pending, land };
}

it("gives an opening made before a close's return lands its visit after it", async () => {
  const returns = deferredReturns();
  const page = fixture(undefined, "tabs", switchboard, returns.driver);
  page.open({ channelId: "alpha", threadId: "root" });
  page.open({ channelId: "beta" }, { keep: true });
  const closing = page.navigation.snapshot().entry;
  page.close({ channelId: "beta" });
  page.open({ channelId: "dm" }, { keep: true });
  page.close({ channelId: "alpha", threadId: "root" });
  // The opening, and the second close, wait for the return in flight.
  expect(returns.pending).toHaveLength(1);
  expect(page.navigation.snapshot().entry).toBe(closing);
  await returns.land();
  expect(page.navigation.snapshot().entry.target).toEqual({
    ...switchboard,
    route: { version: 1, params: { tab: "conversation:dm" } },
  });
  expect(screen.getByText("conversation in Alice")).toBeVisible();
  act(() => page.navigation.back());
  await returns.land();
  expect(page.navigation.snapshot().entry.target).toEqual(switchboard);
});

it("visits an opening made while a close returns once the return lands", async () => {
  const returns = deferredReturns();
  const page = fixture(undefined, "tabs", switchboard, returns.driver);
  page.open({ channelId: "alpha", threadId: "root" });
  page.open({ channelId: "beta" }, { keep: true });
  page.close({ channelId: "beta" });
  page.open({ channelId: "dm" }, { keep: true });
  await returns.land();
  expect(page.navigation.snapshot().entry.target).toEqual({
    ...switchboard,
    route: { version: 1, params: { tab: "conversation:dm" } },
  });
  expect(screen.getByText("conversation in Alice")).toBeVisible();
  act(() => page.navigation.back());
  await returns.land();
  expect(page.navigation.snapshot().entry.target).toEqual({
    ...switchboard,
    route: { version: 1, params: { tab: "thread:alpha:root" } },
  });
});

it("lands a return as the last close before it leaves the page", async () => {
  const returns = deferredReturns();
  const page = fixture(undefined, "tabs", switchboard, returns.driver);
  page.open({ channelId: "alpha" }, { keep: true });
  page.open({ channelId: "alpha", threadId: "root" }, { keep: true });
  page.open({ channelId: "beta" }, { keep: true });
  page.close({ channelId: "beta" });
  hidePane();
  page.close({ channelId: "alpha", threadId: "root" });
  await returns.land();
  expect(page.navigation.snapshot().entry.target).toEqual({
    ...switchboard,
    route: { version: 1, params: { tab: "conversation:alpha" } },
  });
  expect(paneShown()).toBe(false);
});

it("leaves a hidden tab pane hidden when a close's return lands", async () => {
  const returns = deferredReturns();
  const page = fixture(undefined, "tabs", switchboard, returns.driver);
  page.open({ channelId: "alpha" }, { keep: true });
  page.open({ channelId: "beta" }, { keep: true });
  hidePane();
  expect(paneShown()).toBe(false);
  page.close({ channelId: "beta" });
  await returns.land();
  expect(page.navigation.snapshot().entry.target).toEqual({
    ...switchboard,
    route: { version: 1, params: { tab: "conversation:alpha" } },
  });
  expect(paneShown()).toBe(false);
});

it("retires a closed tab's visits only in the scope that closed it", () => {
  const scoped = (communityOrigin: string): OpenTarget => ({
    ...switchboard,
    scope: { viewer: "a".repeat(64), communityOrigin },
  });
  const page = fixture(undefined, "tabs", scoped("https://a.example"));
  page.open({ channelId: "alpha", threadId: "root" });
  act(() => {
    void page.navigation.open(scoped("https://b.example"));
  });
  page.open({ channelId: "alpha", threadId: "root" });
  expect(page.close({ channelId: "alpha", threadId: "root" })).toBe(true);
  expect(page.navigation.snapshot().entry.target).toEqual(
    scoped("https://b.example"),
  );
  traverse(page, "back");
  expect(page.navigation.snapshot().entry.target).toEqual({
    ...scoped("https://a.example"),
    route: { version: 1, params: { tab: "thread:alpha:root" } },
  });
});

it("reopens a tab with Back without taking focus to its composer", () => {
  const page = fixture(undefined, "tabs");
  page.open({ channelId: "alpha" });
  page.open({ channelId: "beta" });
  traverse(page, "back");
  // A falsy request asks for no focus.
  expect(screen.getByText("conversation in alpha")).toHaveAttribute(
    "data-focus",
    "0",
  );
});
