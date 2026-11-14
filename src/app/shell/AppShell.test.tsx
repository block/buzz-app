import { createPortal } from "react-dom";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RegisteredPage } from "../../features/pages/service";
import { createServices, type AppServices } from "../services";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AppShell } from "./AppShell";
import { createAppearance } from "../../shared/theme/service";
import { Context } from "@deepseek-ai/cordis";
import { BackdropsService } from "../../features/backdrops/service";
import { ShellBackdrops } from "../../features/backdrops/ShellBackdrops";
import { ChannelsPage } from "../../bundled/channels/ChannelsPage";

const testAppearance = createAppearance(window);

// Supply a connected presentation without starting network or identity work.
// The session's real capabilities still own rail subscriptions and lifecycle.
function connectedCommunities(current: AppServices) {
  const viewer = "c".repeat(64);
  const origin = "https://relay.test";
  const scope = `${origin}:${viewer}`;
  const connection = {
    ...current.relay.snapshot(),
    status: "ready" as const,
    viewer,
    origin,
    scope,
    session: { ...current.relay.snapshot().session, viewer, scope },
  };
  return {
    ...current.communities,
    relay: {
      ...current.relay,
      snapshot: () => connection,
      subscribe: () => () => {},
    },
  };
}

vi.mock("../../bundled", () => ({ bundledPlugins: [] }));

// jsdom has no media queries or layout observers; responsive geometry is
// covered in browser tests.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("hides, shows and resizes the rail", async () => {
  const current = createServices();
  services = current;
  render(
    <ToastProvider>
      <AppShell
        pages={[
          {
            id: "channels",
            key: "buzz.channels/channels",
            pluginId: "buzz.channels",
            revision: "1",
            title: "Channels",
            component: () => null,
            primary: true,
          },
        ]}
        selected="buzz.channels/channels"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>,
  );
  for (const label of ["Hide sidebar", "Show sidebar", "Hide sidebar"])
    await userEvent.click(screen.getByRole("button", { name: label }));
  await userEvent.click(screen.getByRole("button", { name: "Show sidebar" }));

  const resize = screen.getByRole("separator", { name: "Resize app sidebar" });
  fireEvent.keyDown(resize, { key: "Home" });
  expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
  expect(resize.closest(".shell-workspace")).toHaveStyle({
    "--shell-rail-width": "240px",
  });
  fireEvent.keyDown(resize, { key: "End" });
  expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
  fireEvent.doubleClick(resize);
  expect(resize.closest(".shell-workspace")).toHaveStyle({
    "--shell-rail-width": "304px",
  });
});

it.each([true, false])(
  "keeps primary plugin routes in the universal rail (primary: %s)",
  (primary) => {
    const current = createServices();
    services = current;
    render(
      <ToastProvider>
        <AppShell
          pages={[
            {
              id: "channels",
              key: "buzz.channels/channels",
              pluginId: "buzz.channels",
              revision: "1",
              title: "Channels",
              component: () => null,
              primary: true,
            },
            {
              id: "main",
              key: "example.plugin/main",
              pluginId: "example.plugin",
              revision: "1",
              title: "Beacon",
              component: () => null,
              primary,
            },
          ]}
          selected="example.plugin/main"
          navigationAttempt=""
          onSelect={() => {}}
          tone="default"
          communities={current.communities}
          accountActions={current.accountActions}
          appearance={testAppearance}
        >
          Main app content
        </AppShell>
      </ToastProvider>,
    );
    expect(screen.getByText("Main app content")).toBeVisible();
    const rail = screen.getByRole("navigation", { name: "Apps" });
    const route = within(rail).queryByRole("button", { name: "Beacon" });
    if (primary) expect(route).toBeVisible();
    else expect(route).toBeNull();
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
  },
);

it("renders the default shell unchanged until a plugin registers a backdrop, and again after", async () => {
  const current = createServices();
  services = current;
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const backdrops = new BackdropsService(root);
  const shell = (backdrop?: ReactNode) => (
    <ToastProvider>
      <AppShell
        pages={[]}
        selected="buzz.channels/channels"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
        backdrop={backdrop}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  const view = render(shell());
  const baseline = view.container.innerHTML;
  view.rerender(shell(<ShellBackdrops backdrops={backdrops} />));
  expect(view.container.innerHTML).toBe(baseline);

  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "one" } })
    .plugin((ctx) =>
      ctx.backdrops?.register({
        id: "glow",
        component: () => <canvas data-testid="glow" />,
      }),
    );
  await act(() => fiber.await());
  const layer = screen.getByTestId("glow").closest(".shell-backdrop");
  expect(layer?.parentElement).toHaveClass("shell-background");
  expect(layer).toHaveAttribute("aria-hidden", "true");
  expect(layer).toHaveAttribute("inert");

  await act(() => fiber.dispose());
  expect(view.container.innerHTML).toBe(baseline);
  await root.fiber.dispose();
});

it("opens the header's community switcher from Messages in Personal space", async () => {
  // No saved community: the shell shows Messages without a session, as after
  // leaving the last community or choosing Personal space.
  const current = createServices();
  services = current;
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <AppShell
        pages={[]}
        selected="buzz.channels/channels"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        <ChannelsPage
          relay={current.relay}
          panels={current.panels}
          navigator={current.navigation}
        />
      </AppShell>
    </ToastProvider>,
  );
  const channels = screen.getByRole("region", { name: "Channels" });
  expect(
    within(channels).getByRole("heading", {
      name: "Your channels, one conversation.",
    }),
  ).toBeVisible();
  expect(channels).not.toHaveTextContent(/top bar/i);

  await user.click(
    within(channels).getByRole("button", { name: "Choose a community" }),
  );
  const switcher = await screen.findByRole("dialog", {
    name: "Switch community",
  });
  expect(
    within(switcher).getByRole("button", { name: "Join a community" }),
  ).toBeVisible();

  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Switch community" }),
    ).toBeNull(),
  );
  // Focus returns to the header trigger after the contextual opener closes.
  expect(
    screen.getByRole("button", { name: /^Community switcher: / }),
  ).toHaveFocus();
});

it("keeps rail controls available before page contributions load", () => {
  const current = createServices();
  services = current;
  const pages: RegisteredPage[] = [];
  const shell = (selected: string) => (
    <ToastProvider>
      <AppShell
        pages={pages}
        selected={selected}
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  render(shell("buzz.channels/channels"));
  expect(screen.getByRole("button", { name: "Hide sidebar" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

it("keeps the narrow rail in the Escape-dismissed navigation drawer", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const current = createServices();
  services = current;
  const pages: RegisteredPage[] = [
    {
      id: "main",
      key: "example.plugin/main",
      pluginId: "example.plugin",
      revision: "1",
      title: "Beacon",
      component: () => null,
      primary: true,
    },
  ];
  const shell = (attempt: string) => (
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="buzz.channels/channels"
        navigationAttempt={attempt}
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  const { rerender } = render(shell("first"));
  const nav = document.getElementById("shell-rail");
  const toggle = screen.getByRole("button", { name: "Show navigation" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(toggle);
  expect(nav).toHaveAttribute("aria-hidden", "false");
  expect(nav).not.toHaveAttribute("inert");
  const action = screen.getByRole("button", { name: "Beacon" });
  action.focus();
  // Closing the drawer consumes Escape, so a window-level Escape shortcut
  // (mark as read) does not also fire.
  const reachedWindow = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
  window.addEventListener("keydown", reachedWindow);
  await userEvent.keyboard("{Escape}");
  window.removeEventListener("keydown", reachedWindow);
  expect(reachedWindow).toHaveReturnedWith(true);
  expect(nav).toHaveAttribute("aria-hidden", "true");
  expect(nav).toHaveAttribute("inert");
  expect(screen.getByRole("button", { name: "Show navigation" })).toHaveFocus();

  await userEvent.click(
    screen.getByRole("button", { name: "Show navigation" }),
  );
  rerender(shell("second"));
  expect(nav).toHaveAttribute("aria-hidden", "true");
  expect(nav).toHaveAttribute("inert");
  expect(screen.getByRole("button", { name: "Show navigation" })).toBeVisible();
});

it.each([
  { selected: "buzz.channels/channels" },
  { selected: "inbox" },
  // Global and plugin pages retain the universal rail's New menu.
  { selected: "example.listed/main" },
])(
  "keeps New in the connected rail when supplied ($selected)",
  async ({ selected }) => {
    const current = createServices();
    services = current;
    const select = vi.fn();
    const create = vi.fn();
    const user = userEvent.setup();
    const communities = connectedCommunities(current);
    render(
      <ToastProvider>
        <AppShell
          pages={[
            { id: "channels", pluginId: "buzz.channels" },
            { id: "main", pluginId: "example.listed" },
          ].map((page) => ({
            ...page,
            key: `${page.pluginId}/${page.id}`,
            title: page.pluginId,
            revision: "one",
            primary: true,
            component: () => null,
          }))}
          selected={selected}
          navigationAttempt="same-conversation"
          onSelect={select}
          tone="default"
          communities={communities}
          accountActions={current.accountActions}
          appearance={testAppearance}
          searchServices={current}
          creationAction={(open, onOpenChange, container) => (
            <MenuRoot open={open} onOpenChange={onOpenChange}>
              {container &&
                createPortal(
                  <MenuTrigger render={<button type="button">New</button>} />,
                  container,
                )}
              <MenuPopup>
                <MenuItem onClick={create}>New chat</MenuItem>
              </MenuPopup>
            </MenuRoot>
          )}
        >
          Current conversation
        </AppShell>
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(
      within(screen.getByRole("banner")).queryByRole("button", { name: "New" }),
    ).toBeNull();
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(
      await screen.findByRole("menuitem", { name: "New chat" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Hide sidebar" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(select).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: "New chat" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "New" }));
    await user.click(await screen.findByRole("menuitem", { name: "New chat" }));
    expect(create).toHaveBeenCalledOnce();
  },
);

it("shows global routes in the rail and keeps the conversation mounted across selection", async () => {
  const current = createServices();
  services = current;
  const onSelect = vi.fn();
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Conversation() {
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return <textarea aria-label="Message draft" />;
  }
  const pages = [
    { id: "inbox", pluginId: "buzz.inbox", title: "Inbox" },
    { id: "channels", pluginId: "buzz.channels", title: "Channels" },
    { id: "reminders", pluginId: "buzz.reminders", title: "Reminders" },
    { id: "bestie", pluginId: "buzz.bestie", title: "Bestie" },
  ].map((page) => ({
    ...page,
    key: `${page.pluginId}/${page.id}`,
    revision: "one",
    primary: true,
    component: () => null,
  }));
  const tree = () => (
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="buzz.channels/channels"
        navigationAttempt="same-conversation"
        onSelect={onSelect}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        <Conversation />
      </AppShell>
    </ToastProvider>
  );
  const view = render(tree());
  const user = userEvent.setup();
  const draft = screen.getByRole("textbox", { name: "Message draft" });
  await user.type(draft, "Keep this draft");
  const rail = screen.getByRole("navigation", { name: "Apps" });
  const header = document.querySelector<HTMLElement>(".shell-header");
  if (!header) throw new Error("Missing application toolbar");
  expect(
    within(rail).getByRole("button", { name: /^Community switcher:/ }),
  ).toBeVisible();
  const profile = within(rail).getByRole("button", { name: "Your profile" });
  expect(profile).toBeVisible();
  expect(
    within(header).getByRole("button", { name: "Search Buzz" }),
  ).toBeVisible();
  const inbox = within(rail).getByRole("button", { name: "Inbox" });
  expect(within(rail).getByRole("button", { name: "Bestie" })).toBeVisible();
  expect(within(rail).getByRole("button", { name: "Team" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.getByRole("main")).toContainElement(draft);
  inbox.focus();
  await user.keyboard("{Enter}");
  expect(onSelect).toHaveBeenLastCalledWith("buzz.inbox/inbox");
  expect(screen.getByRole("main")).toHaveFocus();
  view.rerender(tree());
  expect(screen.getByRole("textbox", { name: "Message draft" })).toBe(draft);
  expect(draft).toHaveValue("Keep this draft");
  expect(mounted).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
  await user.click(profile);
  await user.click(await screen.findByRole("menuitem", { name: "Settings" }));
  expect(onSelect).toHaveBeenLastCalledWith("settings", undefined);
});

it.each([
  // Conversations open Messages; each plugin page keeps its own route row.
  ["a conversation", "buzz.channels/channels", "Team"],
  ["Drafts & sent", "buzz.drafts-and-sent/drafts-sent", "Drafts & sent"],
  // A third-party page with `primary: true` and no `placement` or `sidebar`.
  ["a third-party plugin page", "example.pr-status/pr-status", "PR status"],
])(
  "keeps the destination current in the universal rail on %s",
  async (_destination, selected, row) => {
    const current = createServices();
    services = current;
    const onSelect = vi.fn();
    const pages = [
      { id: "inbox", pluginId: "buzz.inbox", title: "Activity" },
      { id: "channels", pluginId: "buzz.channels", title: "Channels" },
      { id: "bestie", pluginId: "buzz.bestie", title: "Bestie" },
      {
        id: "drafts-sent",
        pluginId: "buzz.drafts-and-sent",
        title: "Drafts & sent",
      },
      { id: "pr-status", pluginId: "example.pr-status", title: "PR status" },
    ].map((page) => ({
      ...page,
      key: `${page.pluginId}/${page.id}`,
      revision: "one",
      primary: true,
      component: () => null,
    }));
    render(
      <ToastProvider>
        <AppShell
          pages={pages}
          selected={selected}
          navigationAttempt=""
          onSelect={onSelect}
          tone="default"
          communities={current.communities}
          accountActions={current.accountActions}
          appearance={testAppearance}
        >
          Page content
        </AppShell>
      </ToastProvider>,
    );
    const rail = screen.getByRole("navigation", { name: "Apps" });
    const messages = within(rail).getByRole("button", { name: "Team" });
    const destination = within(rail).getByRole("button", { name: row });
    expect(destination).toHaveAttribute("aria-current", "page");
    expect(
      within(rail).getByRole("button", { name: "Activity" }),
    ).not.toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("main")).toHaveTextContent("Page content");
    await userEvent.click(messages);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("buzz.channels/channels");
    expect(screen.getByRole("main")).toHaveFocus();
  },
);

it("opens the narrow navigation drawer from Drafts & sent", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const current = createServices();
  services = current;
  const pages = [
    { id: "channels", pluginId: "buzz.channels", title: "Channels" },
    {
      id: "drafts-sent",
      pluginId: "buzz.drafts-and-sent",
      title: "Drafts & sent",
    },
  ].map((page) => ({
    ...page,
    key: `${page.pluginId}/${page.id}`,
    revision: "one",
    primary: true,
    component: () => null,
  }));
  render(
    <ToastProvider>
      <AppShell
        pages={pages}
        selected="buzz.drafts-and-sent/drafts-sent"
        navigationAttempt=""
        onSelect={() => {}}
        tone="default"
        communities={current.communities}
        accountActions={current.accountActions}
        appearance={testAppearance}
      >
        Drafts content
      </AppShell>
    </ToastProvider>,
  );
  const navigation = document.getElementById("shell-rail");
  const toggle = screen.getByRole("button", { name: "Show navigation" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(navigation).toHaveAttribute("aria-hidden", "true");
  expect(navigation).toHaveAttribute("inert");
  await userEvent.click(toggle);
  expect(navigation).toHaveAttribute("aria-hidden", "false");
  expect(navigation).not.toHaveAttribute("inert");
  expect(navigation).toContainElement(
    screen.getByRole("button", { name: "Drafts & sent" }),
  );
});

it.each(["sidebar", "dock", "topbar", "toolbar"] as const)(
  "keeps %s plugin icons, badge failures, selection and removal at the navigation boundary",
  async (placement) => {
    const current = createServices();
    services = current;
    const onSelect = vi.fn();
    const icon = "data:image/png;base64,iVBORbeacon";
    const page = (id: string, badge?: () => ReactNode): RegisteredPage => ({
      id,
      key: `example/${id}`,
      pluginId: "example",
      revision: "one",
      title: id,
      primary: true,
      placement,
      icon,
      component: () => null,
      ...(badge ? { badge } : {}),
    });
    const pages = [
      page("Broken", () => {
        throw new Error("broken badge");
      }),
      page("Healthy", () => <span>3 unread</span>),
      { ...page("Search only"), primary: false },
    ];
    const tree = (entries = pages) => (
      <ToastProvider>
        <AppShell
          pages={entries}
          selected="buzz.channels/channels"
          navigationAttempt="same"
          onSelect={onSelect}
          tone="default"
          communities={current.communities}
          accountActions={current.accountActions}
          appearance={testAppearance}
        >
          Retained content
        </AppShell>
      </ToastProvider>
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = render(tree());
      const nav = screen.getByRole("navigation", {
        name: "Apps",
      });
      const role = "button";
      const broken = within(nav).getByRole(role, { name: "Broken" });
      const healthy = within(nav).getByRole(role, { name: /Healthy/ });
      expect(healthy).toHaveTextContent("3 unread");
      expect(screen.getAllByRole(role, { name: /Healthy/ })).toHaveLength(1);
      expect(within(nav).queryByRole(role, { name: "Search only" })).toBeNull();
      const image = broken.querySelector("img");
      expect(image).toHaveAttribute("src", icon);
      if (!image) throw new Error("Plugin image missing");
      fireEvent.error(image);
      expect(broken.querySelector("img")).toBeNull();
      expect(broken.querySelector("svg")).toBeInTheDocument();
      await userEvent.click(healthy);
      expect(onSelect).toHaveBeenLastCalledWith("example/Healthy");
      expect(screen.getByRole("main")).toHaveFocus();
      expect(screen.getByText("Retained content")).toBeVisible();
      view.rerender(tree([]));
      expect(screen.queryByRole(role, { name: /Healthy/ })).toBeNull();
    } finally {
      error.mockRestore();
    }
  },
);

it.each(["sidebar", "topbar"] as const)(
  "previews inactive %s pages on hover while retaining navigation and focus handoff",
  async (placement) => {
    const current = createServices();
    services = current;
    let hover = true;
    vi.stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: hover && media.includes("(hover: hover)"),
      addEventListener() {},
      removeEventListener() {},
    }));
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const communities = connectedCommunities(current);
    const page = (
      id: string,
      preview: RegisteredPage["preview"],
      placement?: RegisteredPage["placement"],
    ): RegisteredPage => ({
      id: id.toLowerCase(),
      key: `example/${id.toLowerCase()}`,
      pluginId: "example",
      revision: "1",
      title: id,
      component: () => null,
      primary: true,
      ...(preview ? { preview } : {}),
      ...(placement ? { placement } : {}),
    });
    const pages = [
      page("Home", undefined, placement),
      page(
        "Inbox",
        ({ close }) => (
          <button type="button" onClick={close}>
            Recent item
          </button>
        ),
        placement,
      ),
      page(
        "Broken",
        () => {
          throw new Error("broken preview");
        },
        placement,
      ),
      page("Notes", undefined, "topbar"),
    ];
    const shell = (selected: string) => (
      <ToastProvider>
        <AppShell
          pages={pages}
          selected={selected}
          navigationAttempt=""
          onSelect={onSelect}
          tone="default"
          communities={communities}
          searchServices={current}
          accountActions={current.accountActions}
          appearance={testAppearance}
        >
          content
        </AppShell>
      </ToastProvider>
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = render(shell("example/home"));
      const landmark = "Apps";
      const role = "button";
      const nav = screen.getByRole("navigation", { name: landmark });
      const inbox = within(nav).getByRole(role, { name: "Inbox" });
      // Rich previews replace the trigger's ordinary title hint.
      expect(inbox).toHaveAttribute("aria-haspopup", "dialog");
      expect(inbox).not.toHaveAttribute("title");
      expect(
        within(nav).getByRole("button", { name: "Notes" }),
      ).not.toHaveAttribute("aria-haspopup");
      // Labelled route rows remain keyboard-operable without opening previews.
      inbox.focus();
      expect(inbox).toHaveAccessibleName("Inbox");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await user.hover(inbox);
      const card = await screen.findByRole("dialog", { name: "Inbox" });
      expect(inbox).toHaveAttribute("data-popup-preview");
      expect(screen.queryByRole("tooltip", { name: "Inbox" })).toBeNull();
      // Content closes the card, for example after opening a conversation, and
      // focus is not pulled back to the row.
      await user.click(
        within(card).getByRole("button", { name: "Recent item" }),
      );
      await waitFor(() => expect(card).not.toBeInTheDocument());
      expect(inbox).not.toHaveFocus();

      // A throwing preview renders nothing and leaves navigation usable.
      const broken = within(nav).getByRole(role, { name: "Broken" });
      await user.hover(broken);
      expect(
        await screen.findByRole("dialog", { name: "Broken" }),
      ).toBeEmptyDOMElement();
      await user.click(broken);
      expect(onSelect).toHaveBeenLastCalledWith("example/broken");
      expect(screen.getByRole("main")).toHaveFocus();
      await user.unhover(broken);
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );

      // Pressing the row selects its page instead of opening the card.
      await user.click(inbox);
      expect(onSelect).toHaveBeenLastCalledWith("example/inbox");
      expect(screen.getByRole("main")).toHaveFocus();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      // A selected page shows no preview of itself.
      view.rerender(shell("example/inbox"));
      expect(within(nav).getByRole(role, { name: "Inbox" })).toBe(inbox);
      expect(screen.getByRole("main")).toHaveFocus();
      expect(
        within(nav).getByRole(role, { name: "Inbox" }),
      ).not.toHaveAttribute("aria-haspopup");
      expect(within(nav).getByRole(role, { name: "Inbox" })).toHaveAttribute(
        "title",
        "Inbox",
      );
      await user.unhover(inbox);
      await user.hover(inbox);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      view.unmount();

      // Devices without hover never get one.
      hover = false;
      render(shell("example/home"));
      expect(
        within(screen.getByRole("navigation", { name: landmark })).getByRole(
          role,
          { name: "Inbox" },
        ),
      ).not.toHaveAttribute("aria-haspopup");
    } finally {
      error.mockRestore();
    }
  },
);
