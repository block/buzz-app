// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import type { SoloRegionProps } from "../../features/channel-navigation/solo-navigation-contract";
import type { SidebarRows } from "../../features/channel-navigation/sidebar-rows-service";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import {
  conversationTarget,
  soloDraftTarget,
} from "../../features/channel-navigation/routes";

import { fixture, owners, id, viewer, scope, root } from "./sidebar-testing";
import { federatedFixture } from "../../features/federated-identity/testing";
import type { ChannelDetails } from "../../features/relay/channel-details-protocol";
import { createSoloRegionFixture } from "../../features/channel-navigation/solo-navigation-testing";
import { PrimarySidebar } from "./sidebar-section-testing";
import type { OpenTarget } from "../../features/navigation/targets";
import { NewMenu } from "./NewMenu";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";
import type {
  RegisteredSidebarRestriction,
  SidebarScope,
} from "../../features/channel-navigation/sidebar-scope-service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createSidebarPreferencesStore } from "../../features/relay/sidebar-preferences-store";
import { SOLO_LABEL } from "../../features/solo/labels";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
import { SIDEBAR_REVEAL_BUDGET_MS } from "../../bundled/channels/useSidebarStartup";
import { teamSidebarSource } from "../../bundled/channels/TeamSidebarSource";
import type { RegisteredSidebarSectionSource } from "../../features/channel-navigation/sidebar-section-components";
import type { RegisteredSidebarSection } from "../../features/channel-navigation/sidebar-sections-service";
stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});

it("double-clicks a Solo row to edit its selected name, retaining a failed save for retry", async () => {
  const user = userEvent.setup();
  const f = fixture();
  const base: ChannelDetails = {
    channelId: id,
    name: "Planning",
    description: "",
    visibility: "private",
    labels: [SOLO_LABEL],
    version: "original",
    canEdit: true,
  };
  const save = vi.fn(async () => {});
  save.mockRejectedValueOnce(new Error("Couldn’t save the name. Try again."));
  Object.assign(f.session, {
    channelDetails: {
      ...f.session.channelDetails,
      available: true,
      load: vi.fn(async () => base),
      save,
    },
  });
  f.navigate(soloDraftTarget(scope));
  const row = screen.getByRole("button", { name: /^Planning/ });
  await user.click(row);
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  f.open.mockClear();
  await user.dblClick(row);
  expect(f.open).toHaveBeenCalledTimes(1);
  const name = await screen.findByRole("textbox", { name: "Chat name" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(name).toHaveFocus());
  expect(name).toHaveValue("Planning");
  expect((name as HTMLInputElement).selectionStart).toBe(0);
  expect((name as HTMLInputElement).selectionEnd).toBe(8);
  await user.keyboard("New plan");
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t save the name",
  );
  expect(name).toHaveValue("New plan");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  expect(save).toHaveBeenLastCalledWith(
    base,
    expect.objectContaining({ name: "New plan", labels: [SOLO_LABEL] }),
    expect.any(AbortSignal),
    undefined,
    f.session.channels,
  );
  await user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  await screen.findByRole("textbox", { name: "Chat name" });
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  expect(save).toHaveBeenCalledTimes(2);
});

it("does not open renaming when Solo details are unavailable", async () => {
  const user = userEvent.setup();
  const f = fixture();
  await user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

function delayedRename() {
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const save: ChannelDetailsCapability["save"] = vi.fn(
    async (_base, _draft, active) => {
      signal = active;
      await gate;
    },
  );
  const f = fixture();
  Object.assign(f.session, {
    channelDetails: {
      ...f.session.channelDetails,
      available: true,
      load: vi.fn(
        async (channelId: string): Promise<ChannelDetails> => ({
          channelId,
          name: channelId === id ? "Planning" : "Other",
          description: "",
          visibility: "private",
          labels: [SOLO_LABEL],
          version: "one",
          canEdit: true,
        }),
      ),
      save,
    },
  });
  f.navigate(soloDraftTarget(scope));
  return {
    user: userEvent.setup(),
    save,
    signal: () => signal,
    finish: async () => {
      await act(async () => {
        finish();
        await gate;
      });
    },
  };
}

it("keeps a click-away save alive when another row is double-clicked", async () => {
  const f = delayedRename();
  await f.user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  const input = screen.getByRole("textbox", { name: "Chat name" });
  await waitFor(() => expect(input).toHaveFocus());
  await f.user.keyboard("First renamed");
  try {
    await f.user.dblClick(screen.getByRole("button", { name: /^Other/ }));
    await waitFor(() => expect(f.save).toHaveBeenCalledOnce());
    expect(input).toHaveValue("First renamed");
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveAttribute("aria-disabled", "true");
    expect(f.signal()?.aborted).toBe(false);
  } finally {
    await f.finish();
  }
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  const destination = screen.getByRole("button", { name: /^Other/ });
  expect(destination).toHaveFocus();
  await f.user.dblClick(destination);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue(
      "Other",
    ),
  );
  await f.user.keyboard("{Escape}");
});

it("keeps focus on a different chat after an Enter-save finishes", async () => {
  const f = delayedRename();
  await f.user.dblClick(screen.getByRole("button", { name: /^Planning/ }));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveFocus(),
  );
  await f.user.keyboard("First renamed{Enter}");
  const destination = screen.getByRole("button", { name: /^Other/ });
  try {
    await waitFor(() => expect(f.save).toHaveBeenCalledOnce());
    await f.user.click(destination);
    expect(destination).toHaveFocus();
  } finally {
    await f.finish();
  }
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
  );
  expect(destination).toHaveFocus();
});
it("shows only chats and the Plugins card under a plugin restriction and restores the other sections after", async () => {
  let restrictions: readonly RegisteredSidebarRestriction[] = [];
  const listeners = new Set<() => void>();
  const publish = (next: readonly RegisteredSidebarRestriction[]) => {
    restrictions = next;
    for (const listener of listeners) listener();
  };
  const sidebarScope: SidebarScope = {
    snapshot: () => restrictions,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    restrict: () => () => {},
  };
  const contributions: readonly RegisteredSidebarSection[] = [
    {
      version: 1,
      id: "inventory",
      key: "test.sidebar/inventory",
      pluginId: "test.sidebar",
      revision: "fixture",
      title: "Plugin heading",
      icon: null,
      rows: {
        snapshot: () => sectionRows,
        subscribe: () => () => {},
      },
      select: () => conversationTarget(scope, "team"),
    },
  ];
  const sectionRows = [{ id: "plugin-row", label: "Plugin row" }];
  const sources: readonly RegisteredSidebarSectionSource[] = [
    {
      ...teamSidebarSource,
      key: "buzz.channels/team",
      pluginId: "buzz.channels",
      revision: "bundled",
    },
    {
      ...teamSidebarSource,
      id: "team-addon",
      key: "test.sidebar/team-addon",
      pluginId: "test.sidebar",
      revision: "fixture",
      component: ({ render }) =>
        render([
          {
            id: "team-addon",
            defaultPosition: 99,
            element: <span>Team plugin slot</span>,
          },
        ]),
    },
  ];
  const f = fixture(
    true,
    false,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    {
      sidebarScope,
      sidebarSections: {
        version: 1,
        register() {},
        subscribe: () => () => {},
        snapshot: () => contributions,
        sourceSnapshot: () => sources,
      },
    },
  );
  f.roster((rows) => [
    ...rows,
    { id: "team", name: "Team row", channelType: "stream" },
  ]);
  expect(await screen.findByText("Plugin heading")).toBeVisible();
  expect(await screen.findByText("Team plugin slot")).toBeVisible();
  act(() =>
    publish([
      {
        id: "focus",
        scope: "solo",
        banner: () => <span>Focusing</span>,
        key: "test.focus/focus",
        pluginId: "test.focus",
        revision: "bundled",
      },
    ]),
  );
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.queryByRole("tabpanel")).toBeNull();
  expect(screen.getByText("Focusing")).toBeVisible();
  // Focus keeps the Plugins card, so its pages stay reachable.
  expect(screen.getByRole("button", { name: "Inbox" })).toBeVisible();
  expect(screen.getByRole("button", { name: /^Planning/ })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "More actions for Team" }),
  ).toBeNull();
  expect(screen.queryByText("Plugin heading")).toBeNull();
  expect(screen.queryByText("Team plugin slot")).toBeNull();
  f.roster((rows) => rows.filter((row) => row.channelType !== "solo"));
  expect(screen.queryByRole("button", { name: /^Planning/ })).toBeNull();
  const user = userEvent.setup();
  await user.click(newMessageButton());
  expect(f.open).toHaveBeenLastCalledWith(
    expect.objectContaining({
      route: { version: 1, params: "new-message" },
    }),
  );
  act(() => publish([]));
  expect(screen.getByRole("button", { name: "Inbox" })).toBeVisible();
  expect(screen.getByText("Plugin heading")).toBeVisible();
  expect(screen.getByText("Team plugin slot")).toBeVisible();
});
it("starts every conversation in New message from the + above the sections", async () => {
  const user = userEvent.setup();
  const f = fixture(true, true);
  expect(screen.queryByRole("tab")).toBeNull();
  const solo = document.querySelector('[data-sidebar-section="solo"]');
  if (!(solo instanceof HTMLElement))
    throw new Error("Missing Messages section");
  // The old Solo-only + is gone; New message is the one way to start a chat.
  expect(
    within(solo).queryByRole("button", { name: "New Solo chat" }),
  ).toBeNull();
  const plus = newMessageButton();
  expect(plus).not.toHaveAttribute("aria-haspopup");
  await user.click(plus);
  expect(f.open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    scope: { viewer, communityOrigin: "https://relay.test" },
    route: { version: 1, params: "new-message" },
  });
});

it("mounts one action menu for each home section", async () => {
  vi.useFakeTimers();
  try {
    fixture(true);
    await act(() => vi.advanceTimersByTimeAsync(SIDEBAR_REVEAL_BUDGET_MS));
    const more = (title: string) =>
      document.querySelector(`button[aria-label="More actions for ${title}"]`);
    expect(more("Messages")).not.toBeNull();
    expect(more("DMs")).not.toBeNull();
    // The old Solo, Team, Chats and Shared with you headings are gone.
    expect(more("Chats")).toBeNull();
    expect(more("Shared with you")).toBeNull();
    expect(more("Solo")).toBeNull();
    expect(more("Team")).toBeNull();
    expect(more("Direct messages")).toBeNull();
    expect(more("Channels")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("expands Messages when navigation selects a team conversation", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(true);
    f.roster((channels) => [
      ...channels,
      { id: "team-channel", name: "Team channel", channelType: "stream" },
    ]);
    await act(() => vi.advanceTimersByTimeAsync(SIDEBAR_REVEAL_BUDGET_MS));
    const summary = document.querySelector<HTMLElement>(
      '[data-sidebar-section="solo"] [aria-controls]',
    );
    expect(summary).not.toBeNull();
    const panel = document.getElementById(
      summary?.getAttribute("aria-controls") ?? "",
    );
    expect(panel).not.toBeNull();
    fireEvent.click(summary as HTMLElement);
    expect(panel).toHaveAttribute("hidden");

    await act(() =>
      f.open({
        version: 1,
        kind: "conversation",
        channelId: "team-channel",
        scope: { viewer, communityOrigin: "https://relay.test" },
      }),
    );
    expect(panel).not.toHaveAttribute("hidden");
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a manually collapsed Solo section closed when navigation selects a chat", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(true);
    f.navigate({
      version: 1,
      kind: "conversation",
      channelId: "team-channel",
      scope: { viewer, communityOrigin: "https://relay.test" },
    });
    await act(() => vi.advanceTimersByTimeAsync(SIDEBAR_REVEAL_BUDGET_MS));
    const summary = document.querySelector<HTMLElement>(
      '[data-sidebar-section="solo"] [aria-controls]',
    );
    expect(summary).not.toBeNull();
    const panel = document.getElementById(
      summary?.getAttribute("aria-controls") ?? "",
    );
    expect(panel).not.toBeNull();
    fireEvent.click(summary as HTMLElement);
    expect(panel).toHaveAttribute("hidden");

    await act(() => f.open(conversationTarget(scope, id)));
    expect(panel).toHaveAttribute("hidden");
    fireEvent.click(summary as HTMLElement);
    expect(panel).not.toHaveAttribute("hidden");
  } finally {
    vi.useRealTimers();
  }
});

it("preserves a source opening only for itself, through a later render", async () => {
  const f = fixture(true);
  f.roster((channels) => [
    ...channels,
    {
      id: "source",
      name: "Source channel",
      channelType: "stream",
      cached: true,
    },
  ]);
  await waitFor(() =>
    expect(document.querySelector('[data-channel-id="source"]')).not.toBeNull(),
  );
  const target = conversationTarget(scope, "source");
  const thread: OpenTarget = {
    version: 1,
    kind: "conversation",
    scope: { viewer, communityOrigin: "https://relay.test" },
    channelId: "source",
    messageId: root,
    threadRootId: root,
  };
  const teamRow = () => document.querySelector('[data-channel-id="source"]');
  await act(() => f.open(target, { sidebar: "preserve" }));
  // Something unrelated rendering the sidebar keeps the preserved opening.
  f.connection({ status: "ready" });
  expect(teamRow()).not.toHaveAttribute("aria-current");
  // A later open in it, here a thread, uses the normal destination rules.
  await act(() => f.open(thread));
  expect(teamRow()).toHaveAttribute("aria-current", "page");
  // Moving within the conversation, as Back and Forward over the thread do,
  // keeps a filter chosen since: it is not a new destination.
  f.navigateWithin(target);
  f.navigateWithin(thread);
  // And a preserved opening from inside that thread applies again.
  await act(() => f.open(target, { sidebar: "preserve" }));
  expect(teamRow()).not.toHaveAttribute("aria-current");
});

/** The sidebar's own +, apart from the Messages section's. */
function newMessageButton() {
  const button = screen
    .getAllByRole("button", { name: "New message" })
    .find((candidate) => !candidate.closest("[data-sidebar-section]"));
  if (!button) throw new Error("Missing the sidebar's New message button");
  return button;
}

const soloFailure = vi.hoisted(() => ({ active: false }));
vi.mock("../../bundled/channels/SoloInventory", async (original) => {
  const actual =
    await original<typeof import("../../bundled/channels/SoloInventory")>();
  return {
    ...actual,
    SoloInventory: (props: Parameters<typeof actual.SoloInventory>[0]) => {
      if (soloFailure.active) throw new Error("Solo inventory failed");
      return <actual.SoloInventory {...props} />;
    },
  };
});

it("contains a Solo render failure without rendering the failed inventory in its fallback", async () => {
  const h = createSoloRegionFixture(viewer);
  h.roster(
    h.session.channels
      .list()
      .channels.map((channel) => ({ ...channel, cached: true })),
  );
  await h.register({
    composeWorkspaces: true,
    component: ({ ui }) => ui.Chats && <ui.Chats />,
  });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  soloFailure.active = true;
  try {
    render(
      <ToastProvider>
        <PrimarySidebar
          relay={h.relay}
          navigator={h.navigator}
          target={conversationTarget(h.scope, "chat")}
        >
          <button type="button">Inbox</button>
        </PrimarySidebar>
      </ToastProvider>,
    );
    expect(screen.getByRole("button", { name: "Inbox" })).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Conversations couldn’t open.",
    );
    soloFailure.active = false;
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry sidebar" }));
    expect(await screen.findByRole("button", { name: /^Chat$/ })).toBeVisible();
  } finally {
    soloFailure.active = false;
    consoleError.mockRestore();
    await h.dispose();
  }
});

it("renders one contributed region heading with no built-in creation action", async () => {
  const h = createSoloRegionFixture(viewer);
  await h.register({ title: "Nexus", component: () => null });
  const target = conversationTarget(h.scope, "owned");
  const view = render(
    <ToastProvider>
      <PrimarySidebar relay={h.relay} navigator={h.navigator} target={target}>
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  try {
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getAllByText("Nexus")).toHaveLength(1);
    // Headings carry no creation of their own; the New menu owns it.
    expect(
      screen.queryByRole("button", { name: "Create" }),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    await h.dispose();
  }
});

it("omits a contributed create action whose menu fails", async () => {
  const h = createSoloRegionFixture(viewer);
  await h.register({
    title: "Nexus",
    component: () => null,
    actions: () => [
      {
        id: "create",
        label: "Create",
        icon: "plus",
        onSelect() {},
        menu() {
          throw new Error("Broken contribution");
        },
      },
    ],
  });
  const view = render(
    <ToastProvider>
      <PrimarySidebar
        relay={h.relay}
        navigator={h.navigator}
        target={conversationTarget(h.scope, "owned")}
      >
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  try {
    expect(screen.getAllByText("Nexus")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Create" }),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    await h.dispose();
  }
});

it("shows a region channel group with its Team row", async () => {
  const h = createSoloRegionFixture(viewer);
  h.session.channelWrites = { ...h.session.channelWrites, available: true };
  h.roster(
    [
      ...h.session.channels.list().channels,
      {
        id: "source",
        name: "Source",
        channelType: "stream",
        members: [viewer],
      },
    ],
    "ready",
  );
  const create = vi.fn();
  let move: (() => void) | undefined;
  function Body({ ui }: SoloRegionProps) {
    const [expanded, setExpanded] = useState(true);
    const [inline, setInline] = useState(true);
    move = () => setInline((value) => !value);
    const Group = ui.ChannelGroup;
    if (!Group) return null;
    return (
      <>
        <button type="button" onClick={() => setInline(!inline)}>
          Move tasks
        </button>
        <Group
          channelId="source"
          onSelect={() => {}}
          expanded={expanded}
          controls="source-tasks"
          disclosureLabel="Toggle Source tasks"
          onToggle={() => setExpanded(!expanded)}
          onNewTask={create}
          headerLeading={{
            icon: <span>Lead</span>,
            label: "Open Lead",
            onActivate() {},
          }}
          {...(inline ? { placement: "team-row" as const } : {})}
        >
          <input aria-label="Task draft" />
        </Group>
      </>
    );
  }
  const source = await h.register({ title: "Nexus", component: Body });
  expect(source.handle.teamRowChannelGroups).toBe(true);
  let rows: ReturnType<SidebarRows["snapshot"]> = [];
  const rowListeners = new Set<() => void>();
  const hide = (hidden: boolean) => {
    rows = hidden
      ? [
          {
            version: 1,
            id: "hide-source",
            key: "example/hide-source",
            pluginId: "example",
            revision: "1",
            render: (item, Default) => (item.id === "source" ? null : Default),
          },
        ]
      : [];
    for (const listener of rowListeners) listener();
  };
  const view = render(
    <ToastProvider>
      <PrimarySidebar
        relay={h.relay}
        navigator={h.navigator}
        target={conversationTarget(h.scope, "chat")}
        sidebarRows={{
          version: 1,
          snapshot: () => rows,
          subscribe(listener) {
            rowListeners.add(listener);
            return () => rowListeners.delete(listener);
          },
          register() {},
        }}
      >
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  const user = userEvent.setup();
  try {
    const group = () =>
      view.container.querySelector('[data-team-row-channel-group="source"]');
    const row = () =>
      view.container.querySelector('button[data-channel-id="source"]');
    const draft = await screen.findByRole(
      "textbox",
      { name: "Task draft" },
      { timeout: SIDEBAR_REVEAL_BUDGET_MS * 2 },
    );
    // The Team row stays the only heading; the region shows no second one.
    expect(group()).toContainElement(row() as HTMLElement);
    expect(group()).toContainElement(draft);
    expect(
      view.container.querySelectorAll("[data-solo-channel-group]"),
    ).toHaveLength(0);
    expect(screen.getAllByText("Source")).toHaveLength(1);
    // The row keeps a plain caret: the region's leading action stays there.
    expect(
      screen.queryByRole("button", { name: "Open Lead" }),
    ).not.toBeInTheDocument();
    const disclosure = screen.getByRole("button", {
      name: "Toggle Source tasks",
    });
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(draft).toBeInTheDocument();
    expect(draft).not.toBeVisible();
    await user.click(disclosure);
    await user.click(
      screen.getByRole("button", { name: "New task in Source" }),
    );
    expect(create).toHaveBeenCalledOnce();

    // Without the placement the group returns to the region and the row to its plain form.
    await user.click(screen.getByRole("button", { name: "Move tasks" }));
    expect(group()).toBeNull();
    expect(row()).toBeInTheDocument();
    expect(
      view.container.querySelector('[data-solo-channel-group="source"]'),
    ).toContainElement(screen.getByRole("textbox", { name: "Task draft" }));
    expect(
      screen.getByRole("button", { name: "Open Lead" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Move tasks" }));
    expect(group()).toContainElement(
      screen.getByRole("textbox", { name: "Task draft" }),
    );

    // Focus in the group's controls returns to the row when they leave it.
    for (const name of ["Toggle Source tasks", "New task in Source"]) {
      screen.getByRole("button", { name }).focus();
      await act(() => move?.());
      await waitFor(() => expect(row()).toHaveFocus());
      await act(() => move?.());
      expect(group()).toContainElement(row() as HTMLElement);
    }

    // The wrapped row is still the channel's own row.
    await user.click(row() as HTMLElement);
    await waitFor(() =>
      expect(h.navigator.snapshot().entry.target).toEqual(
        conversationTarget(h.scope, "source"),
      ),
    );

    // A contribution that hides the row hides its group with it, in both places.
    await act(() => hide(true));
    expect(row()).toBeNull();
    expect(group()).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Task draft" }),
    ).not.toBeInTheDocument();
    await act(() => hide(false));
    expect(group()).toContainElement(
      screen.getByRole("textbox", { name: "Task draft" }),
    );

    // Focus in a control the hidden row takes with it moves to a surviving heading.
    const section = row()?.closest("[data-sidebar-section]");
    const heading = section?.querySelector("summary");
    expect(heading).toBeInstanceOf(HTMLElement);
    for (const name of ["Toggle Source tasks", "New task in Source"]) {
      screen.getByRole("button", { name }).focus();
      await act(() => hide(true));
      await waitFor(() => expect(heading).toHaveFocus());
      await act(() => hide(false));
      expect(group()).toContainElement(row() as HTMLElement);
    }
  } finally {
    view.unmount();
    await h.dispose();
  }
});

it("collapses contributed Solo rows while leaving the single ordinary chat in Solo", async () => {
  const h = createSoloRegionFixture(viewer);
  h.roster(
    h.session.channels
      .list()
      .channels.map((channel) => ({ ...channel, cached: true })),
  );
  await h.register({
    title: "Nexus",
    component: ({ ui }) => (
      <ui.Conversation channelId="owned">
        {(c) => <c.Link label={c.name} />}
      </ui.Conversation>
    ),
  });
  const view = render(
    <ToastProvider>
      <PrimarySidebar
        relay={h.relay}
        navigator={h.navigator}
        target={conversationTarget(h.scope, "chat")}
      >
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  try {
    const heading = view.container.querySelector(
      '[data-sidebar-section^="solo-region:"] summary',
    );
    expect(heading).not.toBeNull();
    await userEvent.setup().click(heading as HTMLElement);
    await waitFor(() =>
      expect(heading?.closest("details")).not.toHaveAttribute("open"),
    );
    expect(
      document.getElementById(heading?.getAttribute("aria-controls") ?? ""),
    ).toHaveAttribute("hidden");
    expect(await screen.findByRole("button", { name: /^Chat/ })).toBeVisible();
    expect(
      view.container.querySelectorAll(
        '[data-solo-channel-id="chat"], [data-solo-destination-id="chat"]',
      ),
    ).toHaveLength(1);
  } finally {
    view.unmount();
    await h.dispose();
  }
});

// A refused community gets one notice in the toast stack on every page, with
// what fixes it. The sidebar's sign-in prompt and Try again would repeat it.
it("moves a refusal's recovery from the sidebar to its one notice", async () => {
  const h = federatedFixture();
  const f = fixture(
    true,
    false,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    {
      federatedIdentity: h.service,
    },
  );
  const sidebar = () => screen.getByRole("complementary", { name: "Sidebar" });
  // A connection failure with native's sign-in error asks for sign-in here.
  f.connection({ status: "error", error: "Federated sign-in is required" });
  expect(
    within(sidebar()).getByRole("button", {
      name: "Sign in with builderlab.example",
    }),
  ).toBeVisible();
  f.connection({ denied: true, refusal: "sign-in" });
  const notice = await screen.findByRole("dialog", {
    name: "Sign in to open this community",
  });
  expect(
    within(notice).getByRole("button", {
      name: "Sign in with builderlab.example",
    }),
  ).toBeVisible();
  expect(
    within(notice).queryByRole("button", { name: "Try again" }),
  ).toBeNull();
  expect(
    within(sidebar()).queryByRole("button", { name: /Sign in|Try again/ }),
  ).toBeNull();
  expect(within(sidebar()).queryByText(/sign-in/)).toBeNull();
});

// NIP-FA: an issuer refusal is not retried automatically, but the user's
// Try again asks the issuer again rather than repeating it from the cache.
it("makes Try again a person's retry, which asks the issuer again", async () => {
  const h = federatedFixture();
  const f = fixture(
    true,
    false,
    undefined,
    undefined,
    0,
    undefined,
    undefined,
    {
      federatedIdentity: h.service,
    },
  );
  const retry = vi.spyOn(f.relay, "retry");
  const tryAgain = vi.spyOn(f.relay, "tryAgain");
  const sidebar = () => screen.getByRole("complementary", { name: "Sidebar" });
  f.connection({
    status: "error",
    error: "grant-refused",
    origin: "wss://relay.example",
  });
  // So its issuer-refusal advice is that Try again, not a restart.
  expect(within(sidebar()).getByRole("alert")).toHaveTextContent(
    "Buzz couldn’t confirm your organization sign-in for this community. Try again. If it keeps happening, contact your administrator.",
  );
  await userEvent
    .setup()
    .click(within(sidebar()).getByRole("button", { name: "Try again" }));
  expect(tryAgain).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
});

it("shows Try again beside a settled failure, and Connecting while the connection retries", async () => {
  const f = fixture(true);
  const retry = vi.spyOn(f.relay, "tryAgain");
  const sidebar = () => screen.getByRole("complementary", { name: "Sidebar" });
  const error = "ReadError: Relay read failed (502)";
  f.connection({ status: "error", error });
  expect(within(sidebar()).getByText("Couldn’t load channels.")).toBeVisible();
  expect(within(sidebar()).queryByText(/ReadError/)).toBeNull();
  await userEvent
    .setup()
    .click(within(sidebar()).getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledOnce();
  // A refusal is about access, not the connection. Its notice reports it on
  // every page; the sidebar neither repeats it nor offers Try again.
  f.connection({
    status: "error",
    error: "ReadError: Relay read failed (403)",
    denied: true,
  });
  const notice = await screen.findByRole("dialog", {
    name: "You don’t have access to this community",
  });
  expect(
    within(notice).getByRole("button", { name: "Check again" }),
  ).toBeVisible();
  expect(within(sidebar()).queryByText("Couldn’t load channels.")).toBeNull();
  expect(within(sidebar()).queryByText(/have access/)).toBeNull();
  expect(
    within(sidebar()).queryByRole("button", { name: "Try again" }),
  ).toBeNull();
  for (const working of [
    { status: "connecting" },
    { status: "error", error, retrying: true },
  ] as const) {
    f.connection(working);
    expect(within(sidebar()).getByText("Connecting…")).toBeVisible();
    expect(
      within(sidebar()).queryByRole("button", { name: "Try again" }),
    ).toBeNull();
  }
});

it("renders each framed workspace once with creation controls and restores the ordinary frame when the source goes away", async () => {
  const h = createSoloRegionFixture(viewer);
  const preferences = createSidebarPreferencesStore({
    available: true,
    writeStar: async () => [],
    read: async () => ({
      sections: [
        { id: "work", name: "Work", order: 0 },
        { id: "empty", name: "Empty", order: 1 },
        { id: "mixed", name: "Mixed", order: 2 },
      ],
      assignments: {
        chat: "work",
        "public-row": "mixed",
        "mixed-chat": "mixed",
      },
      starred: [],
      muted: [],
    }),
  });
  await preferences.queries.ensure();
  Object.assign(h.session, {
    sidebarPreferences: preferences.queries,
  });
  h.roster([
    {
      id: "chat",
      name: "Chat",
      channelType: "solo",
      creator: viewer,
      cached: true,
    },
    {
      id: "mixed-chat",
      name: "Mixed chat",
      channelType: "solo",
      creator: viewer,
    },
    { id: "public-row", name: "Public channel", channelType: "stream" },
  ]);
  const view = render(
    <ToastProvider>
      <NewMenu relay={h.relay} navigator={h.navigator} />
      <PrimarySidebar
        relay={h.relay}
        navigator={h.navigator}
        target={conversationTarget(h.scope, "chat")}
      >
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  const checkOrdinary = async () => {
    expect(
      await screen.findByRole("button", { name: "New message in Work" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "New message in Empty" }),
    ).toBeVisible();
    expect(
      view.container.querySelectorAll(
        '[data-solo-channel-id="chat"], [data-solo-destination-id="chat"]',
      ),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Chats" })).toBeNull();
    expect(newMessageButton()).toBeVisible();
  };
  try {
    await checkOrdinary();
    const source = await act(() =>
      h.register({
        composeWorkspaces: true,
        component: ({ ui }) => {
          const Workspace = ui.Workspace;
          const Chats = ui.Chats;
          if (!Workspace || !Chats)
            throw new Error("Missing workspace composition");
          return (
            <>
              <Workspace id="work" />
              <Workspace id="empty" />
              <Workspace id="mixed" />
              <Chats />
            </>
          );
        },
      }),
    );
    const workspaces = view.container.querySelectorAll(
      '[data-sidebar-section="group:work"]',
    );
    expect(workspaces).toHaveLength(1);
    expect(
      view.container.querySelector('[data-solo-workspace="work"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New message in Work" }),
    ).toBeVisible();
    const mixed = view.container.querySelectorAll(
      '[data-sidebar-section="group:mixed"]',
    );
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toHaveTextContent("Mixed chat");
    expect(mixed[0]).toHaveTextContent("Public channel");
    expect(
      view.container.querySelector('[data-solo-workspace="mixed"]'),
    ).toBeNull();
    expect(
      view.container.querySelectorAll(
        '[data-solo-channel-id="chat"], [data-solo-destination-id="chat"]',
      ),
    ).toHaveLength(1);
    expect(newMessageButton()).toBeVisible();
    await act(() => source.fiber.dispose());
    await checkOrdinary();
  } finally {
    view.unmount();
    preferences.dispose();
    await h.dispose();
  }
});

it("keeps a workspace name editor through a write outage, and a late save never closes a newer edit", async () => {
  const h = createSoloRegionFixture(viewer);
  const groups = {
    sections: [
      { id: "work", name: "Work", order: 0 },
      { id: "mixed", name: "Mixed", order: 1 },
    ],
    assignments: { chat: "work", "public-row": "mixed" },
  };
  let failReads = false;
  const read = vi.fn(async () => {
    if (failReads) throw new Error("offline");
    return { ...groups, starred: [], muted: [] };
  });
  let release = () => {};
  const renameSection = vi.fn(
    () => new Promise<typeof groups>((done) => (release = () => done(groups))),
  );
  const preferences = createSidebarPreferencesStore({
    available: true,
    read,
    renameSection,
  });
  await preferences.queries.ensure();
  Object.assign(h.session, { sidebarPreferences: preferences.queries });
  h.roster([
    {
      id: "chat",
      name: "Chat",
      channelType: "solo",
      creator: viewer,
      cached: true,
    },
    { id: "public-row", name: "Public channel", channelType: "stream" },
  ]);
  const view = render(
    <ToastProvider>
      <PrimarySidebar
        relay={h.relay}
        navigator={h.navigator}
        target={conversationTarget(h.scope, "chat")}
      >
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  const user = userEvent.setup();
  try {
    await user.dblClick(await screen.findByLabelText("Work"));
    const work = screen.getByRole("textbox", { name: "Workspace name" });
    await user.keyboard("Studio");
    // Writes go away while the editor is open; the draft stays.
    failReads = true;
    await act(() => preferences.queries.refresh().catch(() => {}));
    expect(preferences.queries.sectionRenameWritable).toBe(false);
    expect(work).toHaveValue("Studio");
    failReads = false;
    await act(() => preferences.queries.refresh());
    expect(preferences.queries.sectionRenameWritable).toBe(true);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(renameSection).toHaveBeenCalledOnce());
    // A newer edit opens on another workspace before the first save lands.
    await user.dblClick(screen.getByLabelText("Mixed"));
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Workspace name" }),
      ).toHaveValue("Mixed"),
    );
    await act(async () => release());
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue(
      "Mixed",
    );
  } finally {
    view.unmount();
    preferences.dispose();
    await h.dispose();
  }
});

it("shows a disabled region's chat in Solo while leaving its saved filing dormant", async () => {
  const h = createSoloRegionFixture(viewer);
  const saved = {
    sections: [{ id: "personal", name: "Personal", order: 0 }],
    assignments: { owned: "personal" },
    starred: [],
    muted: [],
  };
  const write = vi.fn(async () => saved);
  const preferences = createSidebarPreferencesStore({
    available: true,
    write,
    writeStar: async () => [],
    read: async () => saved,
  });
  await preferences.queries.ensure();
  Object.assign(h.session, { sidebarPreferences: preferences.queries });
  await h.register();
  h.roster(
    h.session.channels
      .list()
      .channels.map((channel) =>
        channel.id === "chat" ? { ...channel, cached: true } : channel,
      ),
  );
  h.plugins({
    status: "ready",
    externalPluginsPaused: false,
    catalog: {
      profile: "fixture",
      location: "Fixture",
      plugins: [
        {
          manifest: { id: "example", name: "Example", apiVersion: 1 },
          source: "external",
          enabled: false,
          revision: "one",
          previous: null,
          reloadable: false,
          error: null,
        },
      ],
    },
  });
  const view = render(
    <ToastProvider>
      <PrimarySidebar
        relay={h.relay}
        navigator={h.navigator}
        target={conversationTarget(h.scope, "owned")}
      >
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  try {
    const row = await screen.findByRole("button", {
      name: /^Owned$/,
    });
    expect(row.closest("[data-sidebar-section]")).toHaveAttribute(
      "data-sidebar-section",
      "solo",
    );
    expect(
      view.container.querySelectorAll('[data-solo-destination-id="owned"]'),
    ).toHaveLength(1);
    row.focus();
    const user = userEvent.setup();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = await screen.findByRole("menu", { name: "Actions for Owned" });
    expect(
      within(menu).queryByRole("menuitem", { name: "Move to…" }),
    ).toBeNull();
    expect(preferences.queries.snapshot().data?.assignments.owned).toBe(
      "personal",
    );
    expect(write).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    preferences.dispose();
    await h.dispose();
  }
});

it.each(["New workspace"])(
  "selects the created workspace through its source from the %s row and retains selection failures for retry",
  async (triggerName) => {
    const h = createSoloRegionFixture(viewer);
    let saved: SidebarPreferences = {
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
    };
    const preferences = createSidebarPreferencesStore({
      available: true,
      writeStar: async () => [],
      read: async () => saved,
      write: async () => saved,
      createSection: async (section) => {
        if (!saved.sections.some(({ id }) => id === section.id))
          saved = {
            ...saved,
            sections: [...saved.sections, { ...section, order: 0 }],
          };
        return saved;
      },
    });
    await preferences.queries.ensure();
    Object.assign(h.session, {
      sidebarPreferences: preferences.queries,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const select = vi.fn(async () => {});
    select.mockImplementationOnce(async () => {
      await gate;
      throw new Error("The workspace could not be opened. Try again.");
    });
    const source = await h.register({
      composeWorkspaces: true,
      openWorkspace: select,
      component: ({ ui }) => (ui.Chats ? <ui.Chats /> : null),
    });
    const open = vi.fn(async () => ({ status: "opened" as const }));
    const navigator = { ...h.navigator, open };
    const view = render(
      <ToastProvider>
        <PrimarySidebar
          relay={h.relay}
          navigator={navigator}
          target={conversationTarget(h.scope, "owned")}
        >
          {null}
        </PrimarySidebar>
      </ToastProvider>,
    );
    const user = userEvent.setup();
    try {
      await user.click(
        await screen.findByRole("button", { name: triggerName }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "New workspace",
      });
      await user.type(
        within(dialog).getByRole("textbox", { name: "Name" }),
        "Planning",
      );
      await user.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(select).toHaveBeenCalledOnce());
      const workspace = saved.sections[0];
      if (!workspace) throw new Error("Missing saved workspace");
      expect(select).toHaveBeenLastCalledWith(source.binding(), workspace.id);
      expect(
        within(dialog).getByRole("textbox", { name: "Name" }),
      ).toBeDisabled();
      expect(open).not.toHaveBeenCalled();
      await act(async () => release());
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "The workspace could not be opened",
      );
      await user.click(within(dialog).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(select).toHaveBeenLastCalledWith(source.binding(), workspace.id);
      expect(saved.sections).toEqual([workspace]);
      expect(open).not.toHaveBeenCalled();
    } finally {
      release();
      view.unmount();
      preferences.dispose();
      await h.dispose();
    }
  },
);

it.each(["neighbor", "heading", "moved"])(
  "recovers plain-list focus after the last chat in a workspace disappears (%s)",
  async (destination) => {
    const h = createSoloRegionFixture(viewer);
    const preferences = createSidebarPreferencesStore({
      available: true,
      writeStar: async () => [],
      read: async () => ({
        sections: [{ id: "work", name: "Work", order: 0 }],
        assignments: { chat: "work" },
        starred: [],
        muted: [],
      }),
    });
    await preferences.queries.ensure();
    Object.assign(h.session, { sidebarPreferences: preferences.queries });
    h.roster([
      {
        id: "chat",
        name: "Chat",
        channelType: "solo",
        creator: viewer,
        cached: true,
      },
      { id: "other", name: "Other", channelType: "solo", creator: viewer },
    ]);
    await h.register({
      composeWorkspaces: true,
      component: ({ ui }) => (ui.ChatList ? <ui.ChatList /> : null),
    });
    const view = render(
      <ToastProvider>
        <PrimarySidebar
          relay={h.relay}
          navigator={h.navigator}
          target={conversationTarget(h.scope, "chat")}
        >
          <button type="button">Elsewhere</button>
        </PrimarySidebar>
      </ToastProvider>,
    );
    try {
      const region = view.container.querySelector<HTMLElement>(
        '[data-sidebar-section="solo-region:example/work"]',
      );
      if (!region) throw new Error("Missing Work region");
      const heading = within(region).getByLabelText("Work", {
        selector: "summary",
      });
      const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
      const chat = screen.getByRole("button", { name: "Chat" });
      chat.focus();
      await act(async () => {
        h.roster(
          destination === "heading"
            ? []
            : h.session.channels
                .list()
                .channels.filter(({ id }) => id !== "chat"),
        );
        if (destination === "moved") elsewhere.focus();
      });
      await waitFor(() => expect(chat).not.toBeInTheDocument());
      expect(
        destination === "neighbor"
          ? screen.getByRole("button", { name: "Other" })
          : destination === "heading"
            ? heading
            : elsewhere,
      ).toHaveFocus();
    } finally {
      view.unmount();
      preferences.dispose();
      await h.dispose();
    }
  },
);

it("keeps an ordinary chat editor and pending save through layout changes and task-source recovery", async () => {
  const h = createSoloRegionFixture(viewer);
  const preferences = createSidebarPreferencesStore({
    available: true,
    writeStar: async () => [],
    read: async () => ({
      sections: [{ id: "work", name: "Work", order: 0 }],
      assignments: { chat: "work" },
      starred: [],
      muted: [],
    }),
  });
  await preferences.queries.ensure();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let savingSignal: AbortSignal | undefined;
  const save = vi.fn<ChannelDetailsCapability["save"]>(
    async (_base, _draft, signal) => {
      savingSignal = signal;
      await gate;
      throw new Error("Couldn’t save the name. Try again.");
    },
  );
  save.mockImplementationOnce(async (_base, _draft, signal) => {
    savingSignal = signal;
    await gate;
    throw new Error("Couldn’t save the name. Try again.");
  });
  Object.assign(h.session, {
    sidebarPreferences: preferences.queries,
    channelDetails: {
      ...h.session.channelDetails,
      available: true,
      load: vi.fn(
        async (): Promise<ChannelDetails> => ({
          channelId: "chat",
          name: "Chat",
          description: "",
          visibility: "private",
          labels: [SOLO_LABEL],
          version: "one",
          canEdit: true,
        }),
      ),
      save,
    },
  });
  h.roster(
    h.session.channels
      .list()
      .channels.map((channel) =>
        channel.id === "unknown" ? { ...channel, cached: true } : channel,
      ),
  );
  const source = await h.register({
    composeWorkspaces: true,
    component: ({ ui, snapshot }) => {
      const Workspace = ui.Workspace;
      const Chats = ui.Chats;
      const ChatList = ui.ChatList;
      if (!Workspace || !Chats || !ChatList)
        throw new Error("Missing workspace composition");
      if (snapshot.model === "list") return <ChatList />;
      return (
        <>
          <Workspace id="work">{null}</Workspace>
          <Chats />
        </>
      );
    },
  });
  const view = render(
    <ToastProvider>
      <PrimarySidebar
        relay={h.relay}
        navigator={h.navigator}
        target={conversationTarget(h.scope, "chat")}
      >
        {null}
      </PrimarySidebar>
    </ToastProvider>,
  );
  const user = userEvent.setup();
  const change = (
    status: "loading" | "ready",
    revision: number,
    model?: string,
  ) =>
    act(() =>
      source.update({
        status,
        binding: source.binding(),
        revision,
        ...(model ? { model } : {}),
      }),
    );
  try {
    await user.dblClick(await screen.findByRole("button", { name: /^Chat$/ }));
    const input = await screen.findByRole("textbox", { name: "Chat name" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard("Keep this name");
    change("ready", 2, "list");
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Chat name" })).toBe(input);
    change("loading", 3);
    expect(screen.getByRole("textbox", { name: "Chat name" })).toBe(input);
    expect(input).toHaveValue("Keep this name");
    change("ready", 4, "list");
    expect(screen.getByRole("textbox", { name: "Chat name" })).toBe(input);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    change("loading", 5);
    expect(savingSignal?.aborted).toBe(false);
    expect(screen.getByRole("textbox", { name: "Chat name" })).toBe(input);
    change("ready", 6, "list");
    expect(savingSignal?.aborted).toBe(false);
    await act(async () => {
      release();
      await gate;
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t save the name",
    );
    expect(input).toHaveValue("Keep this name");
    save.mockResolvedValueOnce(undefined);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Chat name" })).toBeNull(),
    );
  } finally {
    release();
    view.unmount();
    preferences.dispose();
    await h.dispose();
  }
});
