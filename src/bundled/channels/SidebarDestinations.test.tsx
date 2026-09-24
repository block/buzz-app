// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChannelsPage } from "./ChannelsPage";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { PanelsService } from "../../features/panels/service";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import {
  bounds,
  keypair,
  metadata,
  roster,
} from "../../features/relay/testing";

const disposals: (() => void)[] = [];
const noProviders = Object.freeze([]);
const noPages = Object.freeze([]);
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  vi.unstubAllGlobals();
});

function fixture({
  session,
}: {
  session?: (owner: RelaySession) => RelaySession;
} = {}) {
  const viewer = keypair(),
    relayKey = keypair();
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relayKey.pubkey,
    media: () => undefined,
    async query(filters) {
      const filter = filters[0];
      if (filter?.kinds?.some((kind) => kind === 39000 || kind === 39002))
        return [
          metadata(relayKey, "general", "General"),
          roster(relayKey, "general", [viewer.pubkey]),
        ];
      if (filter?.kinds?.includes(0)) return [];
      return [
        bounds(relayKey, "general", "head", {
          has_more: false,
          next_cursor: null,
        }),
      ];
    },
  });
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  disposals.push(() => {
    owner.dispose();
    void ctx.fiber.dispose();
  });
  const snapshot = {
    status: "ready" as const,
    generation: 0,
    session: session ? session(owner.session) : owner.session,
    viewer: viewer.pubkey,
  };
  return {
    providers: {
      snapshot: () => noProviders,
      subscribe: () => () => {},
      register: () => {},
    },
    relay: {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      retry() {},
      disconnect() {},
      clearCache: owner.clearCache,
    },
    panels: new PanelsService(ctx),
    pages: {
      snapshot: () => noPages,
      subscribe: () => () => {},
    },
  };
}

it("switches placeholders and returns to the conversation with one active row", async () => {
  const user = userEvent.setup();
  render(<ChannelsPage {...fixture()} />, { wrapper: ToastProvider });
  const sidebar = within(
    screen.getByRole("complementary", { name: "Channel sidebar" }),
  );
  const general = await sidebar.findByRole("button", {
    name: /^General$/,
  });
  await user.click(sidebar.getByRole("button", { name: "Inbox" }));
  expect(
    within(screen.getByRole("article", { name: "Inbox" })).getByText(
      "Content coming soon",
    ),
  ).toBeInTheDocument();
  expect(general).not.toHaveAttribute("aria-current");
  expect(
    screen.queryByRole("article", { name: "Conversation" }),
  ).not.toBeInTheDocument();
  const bestie = sidebar.getByRole("button", { name: "Bestie" });
  bestie.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("article", { name: "Bestie" })).toHaveTextContent(
    "Content coming soon",
  );
  expect(bestie).toHaveAttribute("aria-current", "page");
  expect(sidebar.getByRole("button", { name: "Inbox" })).not.toHaveAttribute(
    "aria-current",
  );
  await user.click(general);
  expect(
    screen.getByRole("article", { name: "Conversation" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Content coming soon")).not.toBeInTheDocument();
  expect(general).toHaveAttribute("aria-current", "page");
});

it("uses the existing page route and yields to subsequent conversation navigation", async () => {
  const user = userEvent.setup();
  const props = fixture();
  const open = vi.fn();
  const request = (title: "Inbox" | "Bestie"): PageNavigation => ({
    entryId: title,
    target: {
      version: 1,
      kind: "page",
      pluginId: "buzz.channels",
      pageId: "channels",
      route: { version: 1, params: title },
    },
    signal: new AbortController().signal,
    forSession() {
      return this;
    },
    resolve: vi.fn(() => true),
    complete: vi.fn(() => true),
  });
  const inbox = request("Inbox");
  const navigator = {
    open,
    snapshot: () => ({ entry: { id: "general" } }),
  } as unknown as Navigation;
  const view = render(
    <ChannelsPage {...props} navigation={inbox} navigator={navigator} />,
    { wrapper: ToastProvider },
  );
  expect(screen.getByRole("article", { name: "Inbox" })).toBeInTheDocument();
  expect(inbox.complete).toHaveBeenCalledWith({ status: "opened" });
  expect(inbox.resolve).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Bestie" }));
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "page",
      route: { version: 1, params: "Bestie" },
    }),
  );
  view.rerender(<ChannelsPage {...props} navigation={request("Bestie")} />);
  expect(screen.getByRole("article", { name: "Bestie" })).toBeInTheDocument();
  const conversation: PageNavigation = {
    ...request("Inbox"),
    entryId: "general",
    target: {
      version: 1,
      kind: "conversation",
      channelId: "general",
      scope: { viewer: "test", communityOrigin: "https://example.test" },
    },
  };
  view.rerender(<ChannelsPage {...props} navigation={conversation} />);
  expect(
    screen.getByRole("article", { name: "Conversation" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Content coming soon")).not.toBeInTheDocument();
});

it("opens New message from Messages and clears the prior channel selection", async () => {
  const user = userEvent.setup();
  render(<ChannelsPage {...fixture()} />, { wrapper: ToastProvider });
  const sidebar = within(
    screen.getByRole("complementary", { name: "Channel sidebar" }),
  );
  const general = await sidebar.findByRole("button", { name: /^General$/ });
  expect(general).toHaveAttribute("aria-current", "page");

  await user.click(sidebar.getByRole("button", { name: "New message" }));

  expect(
    screen.getByRole("region", { name: "New message" }),
  ).toBeInTheDocument();
  expect(general).not.toHaveAttribute("aria-current");

  await user.click(general);
  expect(general).toHaveAttribute("aria-current", "page");
  expect(
    screen.getByRole("article", { name: "Conversation" }),
  ).toBeInTheDocument();
});

it("routes New message through the existing page navigation contract", async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  const props = fixture();
  const navigation = {
    entryId: "general",
    target: { version: 1, kind: "conversation", channelId: "general" },
    signal: new AbortController().signal,
    forSession() {
      return this;
    },
    resolve: vi.fn(() => true),
    complete: vi.fn(() => true),
  } as unknown as PageNavigation;
  const navigator = {
    open,
    snapshot: () => ({ entry: { id: "general" } }),
  } as unknown as Navigation;
  render(
    <ChannelsPage {...props} navigation={navigation} navigator={navigator} />,
    { wrapper: ToastProvider },
  );

  await user.click(await screen.findByRole("button", { name: "New message" }));

  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "page",
      route: { version: 1, params: "new-message" },
    }),
  );
});

it("opens channel creation with the clicked custom group selected", async () => {
  const user = userEvent.setup();
  const preferences = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: {},
    starred: [],
  };
  const preferenceSnapshot = { status: "ready" as const, data: preferences };
  const kitSnapshot = {
    status: "ready" as const,
    entries: [
      {
        record: {
          version: 1 as const,
          community: "test",
          deleted: false,
          value: {
            type: "groups" as const,
            id: "personal" as const,
            groups: [{ id: "work", name: "Work", defaultTemplateId: "" }],
            assignments: {},
          },
        },
        eventId: "groups",
        createdAt: 1,
      },
    ],
  };
  const props = fixture({
    session: (owner) =>
      ({
        ...owner,
        sidebarPreferences: {
          available: true,
          read: async () => preferences,
          snapshot: () => preferenceSnapshot,
          subscribe: () => () => {},
          ensure: async () => {},
          refresh: async () => {},
        },
        channelCreation: {
          ...owner.channelCreation,
          available: true,
        },
        channelKit: {
          ...owner.channelKit,
          available: true,
          snapshot: () => kitSnapshot,
          subscribe: () => () => {},
          ensure: async () => {},
        },
      }) as RelaySession,
  });
  render(<ChannelsPage {...props} />, { wrapper: ToastProvider });
  const workSection = screen
    .getByLabelText("Work")
    .closest("details")?.parentElement;
  if (!workSection) throw new Error("Missing Work section");

  await user.click(
    within(workSection).getByRole("button", { name: "Create channel" }),
  );

  const dialog = screen.getByRole("dialog", { name: "Create a channel" });
  expect(
    within(dialog).getByRole("combobox", { name: "Destination group" }),
  ).toHaveTextContent("Work");
});
