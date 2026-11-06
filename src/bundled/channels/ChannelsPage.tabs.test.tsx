import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import closeRequest from "../../../src-tauri/src/close-request.js?raw";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  Panels,
  PanelOpenRequest,
  RegisteredPanel,
} from "../../features/panels/service";
import type { PageNavigation } from "../../features/navigation/service";
import type { OpenTarget } from "../../features/navigation/targets";
import {
  conversationTarget,
  soloDraftTarget,
} from "../../features/channel-navigation/routes";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { matchesEvent } from "../../features/relay/projection";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import {
  bounds,
  keypair,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import { readView, writeView } from "../../shared/view-state";
import type { Navigation } from "../../features/navigation/controller";
import { useChannelTabState } from "./useChannelTabState";
import { setThreadPlacementPreference } from "../../features/messages/thread-preferences";
import { SOLO_LABEL } from "../../features/solo/labels";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { ChannelsPage, type LandingReader } from "./ChannelsPage";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { BrowserHostView } from "../../features/browser/BrowserHostView";
import { BrowserSessions } from "../../features/browser/sessions";
import type { BrowserPlatform } from "../../features/browser/platform";

composerDOMFixture();

const owners: ReturnType<typeof createRelaySession>[] = [];
const visitSnapshot = { entry: { id: "visit" }, attempt: {} };
const threadVisitSnapshot = { entry: { id: "thread-visit" }, attempt: {} };
beforeEach(() => {
  // jsdom has no layout/ResizeObserver. Only geometry is substituted; the page,
  // composer, session, tab store and menu interaction are production owners.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  setThreadPlacementPreference("side");
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function page(
  type: "stream" | "solo" = "stream",
  navigator?: Navigation,
  routed = false,
  appComponent?: RegisteredPanel["component"],
  soloPreferences?: RelaySession["soloPreferences"],
) {
  const viewer = keypair(),
    authority = keypair();
  const channelId = "alpha";
  const events = [
    roster(authority, channelId, [viewer.pubkey]),
    metadata(
      authority,
      channelId,
      "Alpha",
      undefined,
      type === "solo"
        ? [["t", "stream"], ["private"], ["t", SOLO_LABEL]]
        : [["t", "stream"]],
    ),
    roster(authority, "beta", [viewer.pubkey]),
    metadata(authority, "beta", "Beta", undefined, [["t", "stream"]]),
    roster(authority, "gamma", [viewer.pubkey]),
    metadata(authority, "gamma", "Gamma", undefined, [
      ["t", "stream"],
      ["private"],
      ["t", SOLO_LABEL],
    ]),
  ];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: authority.pubkey,
      media: () => undefined,
      query: async (filters) =>
        events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
      writer: {
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  owners.push(owner);
  const scope = `https://relay.test:${viewer.pubkey}`;
  const root = routed
    ? signed(viewer, {
        kind: 9,
        tags: [["h", channelId]],
        content: "Initiating thread",
      })
    : undefined;
  if (root) events.push(root);
  writeView(scope, "selected-channel", channelId);
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    viewer: viewer.pubkey,
    // The real session and its stores are frozen; a test may replace one.
    session: soloPreferences
      ? (Object.defineProperty(
          Object.create(owner.session),
          "soloPreferences",
          {
            value: soloPreferences,
          },
        ) as typeof owner.session)
      : owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const panel: RegisteredPanel = {
    id: "notes",
    key: "fixture:notes",
    pluginId: "fixture",
    revision: "1",
    title: "Notes",
    matches: () => false,
    channelPlacement: "tab",
    channelLauncher: ({ context, toggle }) => (
      <button type="button" onClick={() => toggle(context.channelId)}>
        Open notes
      </button>
    ),
    component: () => <input aria-label="Notes draft" />,
  };
  const app: RegisteredPanel = {
    id: "app",
    key: "fixture:app",
    pluginId: "fixture",
    revision: "1",
    title: "App",
    keepOpen: true,
    matches: (target) => target === "https://app.example/",
    component: appComponent ?? (() => <p>App content</p>),
  };
  const available = [panel, app];
  let handleOpen: ((request: PanelOpenRequest) => boolean) | undefined;
  const panels: Panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    resolve: (target) => available.find((entry) => entry.matches(target)),
    register() {},
    requestOpen: (request) => handleOpen?.(request) ?? false,
    handleOpenRequests: (handler) => {
      handleOpen = handler;
      return () => {
        handleOpen = undefined;
      };
    },
  };
  const navigation: PageNavigation | undefined = root
    ? {
        entryId: "thread-visit",
        target: {
          version: 1,
          kind: "conversation",
          scope: {
            viewer: viewer.pubkey,
            communityOrigin: "https://relay.test",
          },
          channelId,
          messageId: root.id,
          threadRootId: root.id,
        },
        signal: new AbortController().signal,
        position: () => undefined,
        savePosition() {},
        forSession() {
          return this;
        },
        resolve: () => true,
        complete: () => true,
        passThrough: () => () => {},
      }
    : undefined;
  render(
    <ToastProvider>
      <ChannelsPage
        relay={relay}
        panels={panels}
        navigator={
          navigator ??
          createNavigationController(createMemoryHistory()).navigation
        }
        navigation={navigation}
      />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  const composer = await screen.findByRole("textbox", {
    name: type === "solo" ? "Message your agents" : "Message #Alpha",
    hidden: routed,
  });
  const open = () =>
    user.click(screen.getByRole("button", { name: "Open notes" }));
  return {
    user,
    composer,
    open,
    session: snapshot.session,
    scope,
    viewer: viewer.pubkey,
    panels,
    root: root?.id,
  };
}

it.each(["side", "main"] as const)(
  "agent-opened apps preserve their routed %s thread",
  async (pane) => {
    setThreadPlacementPreference(pane);
    const open = vi.fn(async () => ({ status: "opened" as const }));
    const h = await page(
      "stream",
      {
        open,
        snapshot: () => threadVisitSnapshot,
      } as unknown as Navigation,
      true,
    );
    const root = h.root;
    if (!root) throw new Error("Routed thread root unavailable");
    const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
    await screen.findByRole("tab", { name: "Initiating thread" });
    act(() =>
      expect(
        h.panels.requestOpen({
          channelId: "alpha",
          rootId: root,
          target: "https://app.example/",
        }),
      ).toBe(true),
    );
    expect(screen.getByRole("tab", { name: "App" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(open).not.toHaveBeenCalled();
    expect(tabs.result.current.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "thread", messageId: root }),
      ]),
    );
    await h.user.click(screen.getByRole("button", { name: "Close App tab" }));
    const thread = screen.getByRole("tab", { name: "Initiating thread" });
    expect(thread).toHaveAttribute("aria-selected", "true");
    expect(open).not.toHaveBeenCalled();
  },
);

/** A page over `events` with no saved selection and no registered panels.
 * A read waits for the promise `hold` returns for its filters, if any; the
 * relay's welcome-channel support is read from `landing`, if given. A history
 * window is served only for a channel whose 39006 bounds are in `events`. */
function workspace(
  events: RelayEvent[],
  viewer = keypair(),
  authority = keypair(),
  hold?: (filters: readonly ReadFilter[]) => Promise<void> | undefined,
  landing?: LandingReader,
) {
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: authority.pubkey,
      media: () => undefined,
      query: async (filters) => {
        await hold?.(filters);
        return events.filter((event) =>
          filters.some(
            (filter) =>
              matchesEvent(event, filter) ||
              // The relay answers a window read with its bounds.
              (event.kind === 39006 &&
                !!filter.top_level &&
                matchesEvent(event, { "#h": filter["#h"] ?? [], limit: 1 })),
          ),
        );
      },
      writer: {
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  owners.push(owner);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: `https://relay.test:${viewer.pubkey}`,
    viewer: viewer.pubkey,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const none: RegisteredPanel[] = [];
  const panels: Panels = {
    snapshot: () => none,
    subscribe: () => () => {},
    resolve: () => undefined,
    register() {},
    requestOpen: () => false,
    handleOpenRequests: () => () => {},
  };
  const controller = createNavigationController(createMemoryHistory());
  const navigator = controller.navigation;
  const page = (navigation?: PageNavigation) => (
    <ToastProvider>
      <ChannelsPage
        relay={relay}
        panels={panels}
        navigator={navigator}
        navigation={navigation}
        landing={landing}
      />
    </ToastProvider>
  );
  const { rerender } = render(page());
  /** Re-route the mounted page; `undefined` returns to the unrouted workspace.
   * A `hosted` visit answers the navigator's pending attempt, as the host's
   * does, so once it has opened it resolves nothing. */
  const visit = (target?: OpenTarget, entryId = "visit", hosted = false) =>
    rerender(
      page(
        target && {
          entryId,
          target,
          signal: new AbortController().signal,
          position: () => undefined,
          savePosition() {},
          passThrough: () => () => {},
          forSession() {
            return this;
          },
          resolve: hosted
            ? (next) => controller.resolve(navigator.snapshot().attempt, next)
            : () => true,
          complete: hosted
            ? (result) =>
                controller.complete(navigator.snapshot().attempt, result)
            : () => true,
        },
      ),
    );
  return {
    owner,
    viewer,
    authority,
    scope: snapshot.scope,
    navigator,
    visit,
  };
}

it("opens the community's auto-join channel first when nothing is saved", async () => {
  const viewer = keypair(),
    authority = keypair();
  workspace(
    [
      roster(authority, "alpha", [viewer.pubkey]),
      metadata(authority, "alpha", "Alpha", undefined, [["t", "stream"]]),
      roster(authority, "beta", [viewer.pubkey]),
      metadata(authority, "beta", "Beta", undefined, [
        ["t", "stream"],
        ["auto_join"],
      ]),
    ],
    viewer,
    authority,
  );
  await screen.findByRole("textbox", { name: "Message #Beta" });
});

it("opens the community's welcome channel before its auto-join channel and pins the welcome above the composer", async () => {
  const viewer = keypair(),
    authority = keypair();
  workspace(
    [
      roster(authority, "alpha", [viewer.pubkey]),
      metadata(authority, "alpha", "Alpha", undefined, [
        ["t", "stream"],
        ["auto_join"],
      ]),
      roster(authority, "beta", [viewer.pubkey]),
      metadata(authority, "beta", "Beta", undefined, [
        ["t", "stream"],
        ["landing"],
        ["welcome", "Say **hi**\nand introduce yourself."],
        ["welcome_title", "Hello, newcomer"],
      ]),
      // Beta's history is empty.
      bounds(authority, "beta", "head", { has_more: false, next_cursor: null }),
    ],
    viewer,
    authority,
  );
  const composer = await screen.findByRole("textbox", {
    name: "Message #Beta",
  });
  // This viewer has written nothing on the relay, so they are new here.
  const welcome = await screen.findByRole("region", {
    name: "Hello, newcomer",
  });
  // The message is Markdown, rendered as a message body is.
  expect(welcome).toHaveTextContent("Say hi and introduce yourself.");
  expect(welcome.querySelector("strong")).toHaveTextContent("hi");
  // Pinned beside the history, not a row in it; an empty channel says so.
  expect(welcome.closest("[data-message-scroller]")).toBeNull();
  expect(await screen.findByText("No messages yet.")).toBeVisible();
  // It never takes focus, and the history leaves room for it.
  expect(welcome).not.toContainElement(document.activeElement as HTMLElement);
  const conversation = composer.closest<HTMLElement>(
    "[data-attachment-drop-zone]",
  );
  expect(
    conversation?.style.getPropertyValue("--channel-preview-inset"),
  ).toMatch(/^calc\(/);
  await userEvent.click(
    within(welcome).getByRole("button", { name: "Dismiss" }),
  );
  expect(screen.queryByRole("region", { name: "Hello, newcomer" })).toBeNull();
  expect(conversation?.style.getPropertyValue("--channel-preview-inset")).toBe(
    "0px",
  );
  // Dismiss leaves with the card, so focus goes on to the composer.
  await vi.waitFor(() => expect(composer).toHaveFocus());
});

it("pins no welcome for a member who wrote on the relay before this device first opened it", async () => {
  const viewer = keypair(),
    authority = keypair();
  const reads: (readonly ReadFilter[])[] = [];
  workspace(
    [
      roster(authority, "beta", [viewer.pubkey]),
      metadata(authority, "beta", "Beta", undefined, [
        ["t", "stream"],
        ["landing"],
      ]),
      signed(viewer, {
        kind: 9,
        content: "Hi all",
        created_at: Math.floor(Date.now() / 1000) - 86_400,
        tags: [["h", "beta"]],
      }),
    ],
    viewer,
    authority,
    (filters) => {
      reads.push(filters);
      return undefined;
    },
  );
  await screen.findByRole("textbox", { name: "Message #Beta" });
  // One read over every kind and channel, for this viewer's events from
  // before the first open less ten minutes.
  await vi.waitFor(() =>
    expect(
      readView(
        `https://relay.test:${viewer.pubkey}`,
        "welcome-earlier-activity",
        undefined,
      ),
    ).toBe(true),
  );
  const asked = reads.filter((filters) =>
    filters.some((filter) => !filter.kinds && !filter.ids),
  );
  expect(asked).toHaveLength(1);
  expect(asked[0]).toStrictEqual([
    {
      authors: [viewer.pubkey],
      limit: 1,
      until:
        readView<number>("https://relay.test", "welcome-first-open", 0) - 600,
    },
  ]);
  expect(screen.queryByRole("region", { name: "Welcome" })).toBeNull();
});

it("waits for the welcome channel's metadata before opening an auto-join channel listed first", async () => {
  const viewer = keypair(),
    authority = keypair();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  const { owner } = workspace(
    [
      roster(authority, "alpha", [viewer.pubkey]),
      metadata(authority, "alpha", "Alpha", undefined, [
        ["t", "stream"],
        ["auto_join"],
      ]),
      roster(authority, "beta", [viewer.pubkey]),
      metadata(authority, "beta", "Beta", undefined, [
        ["t", "stream"],
        ["landing"],
      ]),
    ],
    viewer,
    authority,
    (filters) => {
      // Hold every metadata read naming the welcome channel.
      if (
        !filters.some(
          (filter) =>
            filter.kinds?.includes(39000) && filter["#d"]?.includes("beta"),
        )
      )
        return;
      holding = true;
      return held;
    },
  );
  try {
    await vi.waitFor(() => expect(holding).toBe(true));
    // The auto-join channel's metadata lands first, by an exact lookup.
    await act(() => owner.session.channels.resolve?.(["alpha"]));
    const listed = owner.session.channels.list().channels;
    const alpha = listed.find(({ id }) => id === "alpha");
    expect(alpha?.autoJoin).toBe(true);
    expect(alpha?.metadataPending).toBeFalsy();
    expect(listed.find(({ id }) => id === "beta")?.metadataPending).toBe(true);
    expect(screen.getByText("Opening your channels…")).toBeVisible();
    expect(
      screen.queryByRole("textbox", { name: "Message #Alpha" }),
    ).toBeNull();
  } finally {
    release();
  }
  await screen.findByRole("textbox", { name: "Message #Beta" });
  expect(await screen.findByRole("region", { name: "Welcome" })).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Message #Alpha" })).toBeNull();
});

it("shows the default welcome only in the welcome channel", async () => {
  const viewer = keypair(),
    authority = keypair();
  const { visit, scope } = workspace(
    [
      roster(authority, "alpha", [viewer.pubkey]),
      metadata(authority, "alpha", "Alpha", undefined, [
        ["t", "stream"],
        // A stale message without the designation is ignored.
        ["welcome", "Old"],
      ]),
      roster(authority, "beta", [viewer.pubkey]),
      metadata(authority, "beta", "Beta", undefined, [
        ["t", "stream"],
        ["landing"],
      ]),
    ],
    viewer,
    authority,
  );
  expect(
    await screen.findByRole("region", { name: "Welcome" }),
  ).toHaveTextContent("This is a place to connect with the community");
  visit(conversationTarget(scope, "alpha"));
  await screen.findByRole("textbox", { name: "Message #Alpha" });
  expect(screen.queryByRole("region", { name: "Welcome" })).toBeNull();
  expect(screen.queryByText("Old")).toBeNull();
});

it("keeps a saved selection over the welcome channel", async () => {
  const viewer = keypair(),
    authority = keypair();
  writeView(`https://relay.test:${viewer.pubkey}`, "selected-channel", "alpha");
  workspace(
    [
      roster(authority, "alpha", [viewer.pubkey]),
      metadata(authority, "alpha", "Alpha", undefined, [["t", "stream"]]),
      roster(authority, "beta", [viewer.pubkey]),
      metadata(authority, "beta", "Beta", undefined, [
        ["t", "stream"],
        ["landing"],
      ]),
    ],
    viewer,
    authority,
  );
  await screen.findByRole("textbox", { name: "Message #Alpha" });
  expect(screen.queryByRole("region", { name: "Welcome" })).toBeNull();
});

it("falls back when the viewer is not in the welcome channel", async () => {
  const viewer = keypair(),
    authority = keypair(),
    other = keypair();
  workspace(
    [
      roster(authority, "alpha", [viewer.pubkey]),
      metadata(authority, "alpha", "Alpha", undefined, [["t", "stream"]]),
      roster(authority, "beta", [other.pubkey]),
      metadata(authority, "beta", "Beta", undefined, [
        ["t", "stream"],
        ["public"],
        ["landing"],
      ]),
    ],
    viewer,
    authority,
  );
  await screen.findByRole("textbox", { name: "Message #Alpha" });
});

it("keeps opening after an empty first list, then offers a list refresh instead of a blank view", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const viewer = keypair(),
      authority = keypair();
    const events: RelayEvent[] = [];
    const { owner } = workspace(events, viewer, authority);
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    // The relay may still be adding this new member to the welcome channel.
    expect(screen.getByText("Opening your channels…")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "You’re not in any channels yet" }),
    ).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(9_000));
    expect(screen.getByText("Opening your channels…")).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(
      screen.getByRole("heading", { name: "You’re not in any channels yet" }),
    ).toBeVisible();
    expect(screen.queryByText("Select a channel to read it.")).toBeNull();
    // Try again re-reads the list rather than reconnecting a healthy session,
    // and waits for it the same bounded way.
    events.push(
      roster(authority, "beta", [viewer.pubkey]),
      metadata(authority, "beta", "Beta", undefined, [
        ["t", "stream"],
        ["landing"],
      ]),
    );
    const tryAgain = screen.getByRole("button", { name: "Try again" });
    tryAgain.focus();
    fireEvent.click(tryAgain);
    expect(
      screen.queryByRole("heading", { name: "You’re not in any channels yet" }),
    ).toBeNull();
    expect(
      screen.getByRole("region", { name: "Channel history" }),
    ).toHaveFocus();
    await screen.findByRole("textbox", { name: "Message #Beta" });
  } finally {
    vi.useRealTimers();
  }
});

it("opens the welcome channel as soon as it arrives while the opening state waits", async () => {
  const viewer = keypair(),
    authority = keypair();
  const events: RelayEvent[] = [];
  const { owner } = workspace(events, viewer, authority);
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  expect(screen.getByText("Opening your channels…")).toBeVisible();
  events.push(
    roster(authority, "beta", [viewer.pubkey]),
    metadata(authority, "beta", "Beta", undefined, [
      ["t", "stream"],
      ["landing"],
    ]),
  );
  owner.session.channels.refreshList?.();
  await screen.findByRole("textbox", { name: "Message #Beta" });
  expect(await screen.findByRole("region", { name: "Welcome" })).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "You’re not in any channels yet" }),
  ).toBeNull();
});

/** The Messages page, opened through the navigator's own visit. */
const messagesPage: OpenTarget = {
  version: 1,
  kind: "page",
  pluginId: "buzz.channels",
  pageId: "channels",
};

it("shows an empty list at once on a relay without welcome channels", async () => {
  const landing = vi.fn<LandingReader>(async () => ({
    landingChannels: false,
  }));
  const { owner } = workspace([], keypair(), keypair(), undefined, landing);
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  // No one is being added to a welcome channel, so there is nothing to wait for.
  expect(
    await screen.findByRole("heading", {
      name: "You’re not in any channels yet",
    }),
  ).toBeVisible();
  expect(screen.queryByText("Opening your channels…")).toBeNull();
  expect(landing).toHaveBeenCalledWith("https://relay.test", expect.anything());
});

/** A member listed in a DM, and with `joined` in a stream channel they joined
 * themselves, on a relay whose NIP-11 names `beta` as its welcome channel. */
async function awaitingWelcome({ hosted = false, joined = false } = {}) {
  const viewer = keypair(),
    authority = keypair(),
    other = keypair();
  const events: RelayEvent[] = [
    roster(authority, "pat", [viewer.pubkey, other.pubkey]),
    metadata(authority, "pat", "Pat", undefined, [["t", "dm"]]),
    ...(joined
      ? [
          roster(authority, "alpha", [viewer.pubkey, other.pubkey]),
          metadata(authority, "alpha", "Alpha", undefined, [["t", "stream"]]),
        ]
      : []),
  ];
  const landing = vi.fn<LandingReader>(async () => ({
    landingChannels: true,
    landingChannel: "beta",
  }));
  const { owner, scope, navigator, visit } = workspace(
    events,
    viewer,
    authority,
    undefined,
    landing,
  );
  if (hosted) visit(messagesPage, navigator.snapshot().entry.id, true);
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  await vi.waitFor(() => expect(landing).toHaveBeenCalledOnce());
  // The read has answered and the page has rendered its outcome.
  await act(async () => {});
  return { owner, scope, navigator, viewer, authority, events };
}

it("waits for the welcome channel the relay names rather than open a DM, then opens it", async () => {
  const { owner, viewer, authority, events } = await awaitingWelcome();
  expect(screen.getByText("Opening your channels…")).toBeVisible();
  expect(screen.queryByRole("textbox")).toBeNull();
  events.push(
    roster(authority, "beta", [viewer.pubkey]),
    metadata(authority, "beta", "Beta", undefined, [
      ["t", "stream"],
      ["landing"],
    ]),
  );
  owner.session.channels.refreshList?.();
  await screen.findByRole("textbox", { name: "Message #Beta" });
  expect(await screen.findByRole("region", { name: "Welcome" })).toBeVisible();
});

it("opens a channel the person joined themselves at once, though the relay names an unlisted welcome channel", async () => {
  // Only a new member's list, of starter channels and DMs, is still being
  // filled by the relay; an established member's is not held.
  await awaitingWelcome({ joined: true });
  expect(
    await screen.findByRole("textbox", { name: "Message #Alpha" }),
  ).toBeVisible();
  expect(screen.queryByText("Opening your channels…")).toBeNull();
});

it("skips the NIP-11 read for a saved selection whose metadata is still arriving", async () => {
  const viewer = keypair(),
    authority = keypair();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const landing = vi.fn<LandingReader>(async () => ({
    landingChannels: true,
    landingChannel: "beta",
  }));
  const scope = `https://relay.test:${viewer.pubkey}`;
  writeView(scope, "selected-channel", "alpha");
  const { owner } = workspace(
    [
      roster(authority, "alpha", [viewer.pubkey]),
      metadata(authority, "alpha", "Alpha", undefined, [["t", "stream"]]),
    ],
    viewer,
    authority,
    (filters) =>
      filters.some(
        (filter) =>
          filter.kinds?.includes(39000) && filter["#d"]?.includes("alpha"),
      )
        ? held
        : undefined,
    landing,
  );
  try {
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    expect(
      owner.session.channels.list().channels.find(({ id }) => id === "alpha")
        ?.metadataPending,
    ).toBe(true);
    expect(screen.getByText("Opening your channels…")).toBeVisible();
  } finally {
    release();
  }
  await screen.findByRole("textbox", { name: "Message #Alpha" });
  expect(landing).not.toHaveBeenCalled();
});

it("reads NIP-11 and holds for a newcomer's list whose saved selection is archived", async () => {
  const viewer = keypair(),
    authority = keypair(),
    other = keypair();
  const landing = vi.fn<LandingReader>(async () => ({
    landingChannels: true,
    landingChannel: "beta",
  }));
  const scope = `https://relay.test:${viewer.pubkey}`;
  // An archived selection is listed, but not shown or read; the rest of the
  // list is a DM, as a new member's can be.
  writeView(scope, "selected-channel", "old");
  const { owner } = workspace(
    [
      roster(authority, "old", [viewer.pubkey]),
      metadata(authority, "old", "Old", undefined, [
        ["t", "stream"],
        ["archived", "true"],
      ]),
      roster(authority, "pat", [viewer.pubkey, other.pubkey]),
      metadata(authority, "pat", "Pat", undefined, [["t", "dm"]]),
    ],
    viewer,
    authority,
    undefined,
    landing,
  );
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  await vi.waitFor(() => expect(landing).toHaveBeenCalledOnce());
  await act(async () => {});
  expect(screen.getByText("Opening your channels…")).toBeVisible();
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("opens and keeps the DM once the welcome channel the relay names stays unlisted", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { scope, navigator } = await awaitingWelcome({ hosted: true });
    // The visit opened on the wait; the DM then replaces it.
    expect(navigator.snapshot().status).toBe("opened");
    await act(() => vi.advanceTimersByTimeAsync(9_000));
    expect(screen.getByText("Opening your channels…")).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(await screen.findByRole("textbox")).toBeVisible();
    expect(navigator.snapshot()).toMatchObject({
      canGoBack: false,
      entry: { target: { kind: "conversation", channelId: "pat" } },
    });
    // Saved, so the next opening shows it without waiting again.
    expect(readView(scope, "selected-channel", undefined)).toBe("pat");
  } finally {
    vi.useRealTimers();
  }
});

it("opens and saves a welcome channel that arrives after the empty list settled", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const viewer = keypair(),
      authority = keypair();
    const events: RelayEvent[] = [];
    const { owner, scope, navigator, visit } = workspace(
      events,
      viewer,
      authority,
    );
    visit(messagesPage, navigator.snapshot().entry.id, true);
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(
      screen.getByRole("heading", { name: "You’re not in any channels yet" }),
    ).toBeVisible();
    // The visit opened on the empty state, so it can no longer be resolved.
    expect(navigator.snapshot().status).toBe("opened");
    events.push(
      roster(authority, "beta", [viewer.pubkey]),
      metadata(authority, "beta", "Beta", undefined, [
        ["t", "stream"],
        ["landing"],
      ]),
    );
    owner.session.channels.refreshList?.();
    await screen.findByRole("textbox", { name: "Message #Beta" });
    // The same opening, corrected: no way back to the empty state.
    expect(navigator.snapshot()).toMatchObject({
      canGoBack: false,
      entry: { target: { kind: "conversation", channelId: "beta" } },
    });
    expect(readView(scope, "selected-channel", undefined)).toBe("beta");
  } finally {
    vi.useRealTimers();
  }
});

it("selects a default channel the relay adds after the page opened", async () => {
  const events: RelayEvent[] = [];
  const { owner, viewer, authority } = workspace(events);
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  expect(screen.queryByRole("textbox")).toBeNull();
  // A 44100 membership hint resolves the channel through the same store entry.
  events.push(
    roster(authority, "beta", [viewer.pubkey]),
    metadata(authority, "beta", "Beta", undefined, [
      ["t", "stream"],
      ["auto_join"],
    ]),
  );
  await act(() => owner.session.channels.resolve?.(["beta"]));
  await screen.findByRole("textbox", { name: "Message #Beta" });
});

/** A new member's empty first list, then a membership hint confirming their
 * starter channel on its own read, as the relay's hints can arrive; with
 * `listedFirst`, the first list already has it. Routed, the page shows the
 * navigator's current visit, as the host routes Messages. */
async function starterConfirmedFirst({
  routed = false,
  listedFirst = false,
} = {}) {
  const viewer = keypair(),
    authority = keypair();
  const starter = [
    roster(authority, "alpha", [viewer.pubkey]),
    metadata(authority, "alpha", "Alpha", undefined, [
      ["t", "stream"],
      ["auto_join"],
    ]),
  ];
  const events: RelayEvent[] = listedFirst ? [...starter] : [];
  const { owner, scope, navigator, visit } = workspace(
    events,
    viewer,
    authority,
  );
  if (routed)
    visit(
      {
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
      },
      navigator.snapshot().entry.id,
    );
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  if (!listedFirst) {
    events.push(...starter);
    await act(() => owner.session.channels.resolve?.(["alpha"]));
  }
  const alpha = await screen.findByRole("textbox", { name: "Message #Alpha" });
  /** The welcome channel's hint, confirmed on a later read. Returns once the
   * page has rendered the confirmed list and run its effects, so the switch
   * has happened or never will; the first test below proves it. */
  const confirmWelcome = async () => {
    events.push(
      roster(authority, "beta", [viewer.pubkey]),
      metadata(authority, "beta", "Beta", undefined, [
        ["t", "stream"],
        ["landing"],
      ]),
    );
    await act(() => owner.session.channels.resolve?.(["beta"]));
    await vi.waitFor(() =>
      expect(
        owner.session.channels.list().channels.find(({ id }) => id === "beta")
          ?.landing,
      ).toBe(true),
    );
    await act(async () => {});
  };
  return { alpha, scope, navigator, visit, confirmWelcome };
}

/** The starter channel kept: shown, and its history entry untouched. */
function expectStarterKept(navigator: Navigation, shown = "home") {
  expect(navigator.snapshot().entry.target.kind).toBe(shown);
  expect(screen.getByRole("textbox", { name: "Message #Alpha" })).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Message #Beta" })).toBeNull();
}

it("opens a welcome channel confirmed after the starter channel it opened first", async () => {
  const { navigator, confirmWelcome } = await starterConfirmedFirst();
  await confirmWelcome();
  // Asserted at once: the barrier the tests below rely on covers the switch.
  // It replaces the opening, leaving no way back to the starter channel.
  expect(navigator.snapshot()).toMatchObject({
    canGoBack: false,
    entry: { target: { kind: "conversation", channelId: "beta" } },
  });
  await screen.findByRole("textbox", { name: "Message #Beta" });
  expect(await screen.findByRole("region", { name: "Welcome" })).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Message #Alpha" })).toBeNull();
});

it("opens a welcome channel that follows the starter channel across a routed visit's handoff", async () => {
  // The starter channel is chosen while the routed visit is still pending.
  const { scope, navigator, visit, confirmWelcome } =
    await starterConfirmedFirst({ routed: true, listedFirst: true });
  const entryId = navigator.snapshot().entry.id;
  // Resolving the visit to it hands the route off: one commit without
  // navigation, then the same history entry as a conversation.
  visit();
  visit(conversationTarget(scope, "alpha"), entryId);
  await confirmWelcome();
  expect(navigator.snapshot()).toMatchObject({
    canGoBack: false,
    entry: { target: { kind: "conversation", channelId: "beta" } },
  });
});

it.each([
  [
    "clicks in it",
    async (alpha: HTMLElement) => {
      await userEvent.setup().click(alpha);
    },
  ],
  [
    "presses a key outside Messages",
    async () => {
      render(<button type="button">Sidebar</button>);
      fireEvent.keyDown(screen.getByRole("button", { name: "Sidebar" }), {
        key: "Tab",
      });
    },
  ],
])(
  "keeps the starter channel once the reader %s, though the welcome channel follows",
  async (_, input) => {
    const { alpha, navigator, confirmWelcome } = await starterConfirmedFirst();
    await input(alpha);
    await confirmWelcome();
    expectStarterKept(navigator);
  },
);

it.each([
  ["a routed", true],
  ["an unrouted", false],
])(
  "leaves Settings open over %s starter channel when the welcome channel follows",
  async (_, routed) => {
    const { navigator, confirmWelcome } = await starterConfirmedFirst({
      routed,
    });
    // Messages stays mounted with its visit behind Settings, as the host keeps it.
    void navigator.open({ version: 1, kind: "settings" });
    await confirmWelcome();
    expectStarterKept(navigator, "settings");
  },
);

it("leaves focus outside Messages where it is when the welcome channel replaces the starter channel", async () => {
  const { confirmWelcome } = await starterConfirmedFirst();
  render(<button type="button">Sidebar</button>);
  const sidebar = screen.getByRole("button", { name: "Sidebar" });
  // Focus can move without a click or key press, as when a dialog returns it.
  act(() => sidebar.focus());
  await confirmWelcome();
  await screen.findByRole("textbox", { name: "Message #Beta" });
  expect(sidebar).toHaveFocus();
});

it("keeps the starter channel when the welcome channel follows after the opening window", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { navigator, confirmWelcome } = await starterConfirmedFirst();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await confirmWelcome();
    expectStarterKept(navigator);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the channel being read when a default channel arrives later", async () => {
  const viewer = keypair(),
    authority = keypair();
  const events: RelayEvent[] = [
    roster(authority, "alpha", [viewer.pubkey]),
    metadata(authority, "alpha", "Alpha", undefined, [["t", "stream"]]),
  ];
  const { owner } = workspace(events, viewer, authority);
  await screen.findByRole("textbox", { name: "Message #Alpha" });
  events.push(
    roster(authority, "beta", [viewer.pubkey]),
    metadata(authority, "beta", "Beta", undefined, [
      ["t", "stream"],
      ["auto_join"],
    ]),
  );
  await act(() => owner.session.channels.resolve?.(["beta"]));
  await vi.waitFor(() =>
    expect(
      owner.session.channels.list().channels.map(({ id }) => id),
    ).toContain("beta"),
  );
  expect(screen.getByRole("textbox", { name: "Message #Alpha" })).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Message #Beta" })).toBeNull();
});

it("keeps the computed channel across a New chat draft opened and closed meanwhile", async () => {
  const viewer = keypair(),
    authority = keypair();
  const events: RelayEvent[] = [
    roster(authority, "alpha", [viewer.pubkey]),
    metadata(authority, "alpha", "Alpha", undefined, [["t", "stream"]]),
  ];
  const { owner, scope, visit } = workspace(events, viewer, authority);
  await screen.findByRole("textbox", { name: "Message #Alpha" });
  visit(soloDraftTarget(scope));
  await screen.findByRole("region", { name: "New chat" });
  events.push(
    roster(authority, "beta", [viewer.pubkey]),
    metadata(authority, "beta", "Beta", undefined, [
      ["t", "stream"],
      ["auto_join"],
    ]),
  );
  await act(() => owner.session.channels.resolve?.(["beta"]));
  await vi.waitFor(() =>
    expect(
      owner.session.channels.list().channels.map(({ id }) => id),
    ).toContain("beta"),
  );
  visit();
  expect(
    await screen.findByRole("textbox", { name: "Message #Alpha" }),
  ).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Message #Beta" })).toBeNull();
});

it("moving the last side app adopts its guest before the dock exit finishes", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 500),
  );
  let finishExit = () => {};
  const finished = new Promise<void>((resolve) => {
    finishExit = resolve;
  });
  const originalAnimations = HTMLElement.prototype.getAnimations;
  const getAnimations = vi.fn(() => [{ finished }]);
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: getAnimations,
  });
  const pages = new Map<string, string>();
  const attached = vi.fn(async (url: string) => {
    const id = `guest-${pages.size + 1}`;
    pages.set(id, url);
    return id;
  });
  const detached = vi.fn(async (id: string) => {
    pages.delete(id);
  });
  const observed: string[] = [];
  const platform: BrowserPlatform = {
    available: true,
    attach: attached,
    detach: detached,
    openExternal: vi.fn(async () => {}),
    setBounds: async () => {},
    navigate: async (id, url) => {
      pages.set(id, url);
    },
    action: async () => {},
    status: async (id) => {
      const url = pages.get(id) ?? "";
      observed.push(url);
      return { url, title: "App", loading: false, error: null };
    },
  };
  const sessions = new BrowserSessions(platform);
  const App = () => (
    <BrowserHostView
      url="https://app.example/"
      storage="builderlab-apps"
      platform={platform}
      sessions={sessions}
    />
  );
  try {
    const h = await page("stream", undefined, false, App);
    act(() =>
      expect(
        h.panels.requestOpen({
          channelId: "alpha",
          target: "https://app.example/",
        }),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(attached).toHaveBeenCalledTimes(1));
    const address = screen.getByRole("textbox", { name: "Address" });
    await h.user.clear(address);
    await h.user.type(address, "https://app.example/second.html{Enter}");
    await vi.waitFor(() =>
      expect(observed).toContain("https://app.example/second.html"),
    );
    const source = document.querySelector("[data-panel-dock]");
    const sourceGuest = source
      ?.querySelector("[data-browser-session]")
      ?.getAttribute("data-browser-session");
    expect(sourceGuest).toBe("guest-1");
    screen.getByRole("tab", { name: "App" }).focus();
    await h.user.keyboard("{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}");
    const main = document.querySelector<HTMLElement>("[data-main-workspace]");
    if (!main) throw new Error("Main workspace unavailable");
    fireEvent.animationEnd(within(main).getByRole("tabpanel", { name: "App" }));
    await vi.waitFor(() =>
      expect(main.querySelector("[data-browser-session]")).not.toBeNull(),
    );
    expect(getAnimations).toHaveBeenCalled();
    expect(source).toHaveAttribute("data-closing");
    expect(main.querySelector("[data-browser-session]")).toHaveAttribute(
      "data-browser-session",
      sourceGuest,
    );
    expect(attached).toHaveBeenCalledTimes(1);
    expect(detached).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(
        within(main).getByRole("textbox", { name: "Address" }),
      ).toHaveValue("https://app.example/second.html"),
    );
    await act(async () => finishExit());
    expect(main.querySelector("[data-browser-session]")).toHaveAttribute(
      "data-browser-session",
      sourceGuest,
    );
    expect(attached).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => finishExit());
    if (originalAnimations)
      HTMLElement.prototype.getAnimations = originalAnimations;
    else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
  }
});

const closeTabs = (tabEvent = "buzz:close-all-tabs") => {
  let handled = false;
  act(() => {
    handled =
      new Function(
        "window",
        "document",
        "Event",
        "tabEvent",
        `return eval(${JSON.stringify(closeRequest)})`,
      )(window, document, Event, tabEvent) === "handled";
  });
  return handled;
};

it("solo conversation bounds its hover surfaces inside its pane", async () => {
  const h = await page("solo");
  expect(h.composer.closest("[data-overlay-boundary]")).toBe(
    screen.getByRole("article", { name: "Conversation" }),
  );
});

it("solo composer retains side-tab cycling and close focus", async () => {
  const h = await page("solo");
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  const root = "b".repeat(64);
  act(() =>
    tabs.result.current.openThreadTab("alpha", root, root, undefined, "side"),
  );
  await h.open();
  const thread = screen.getByRole("tab", { name: "Thread · Alpha" });
  const notes = screen.getByRole("tab", { name: "Notes" });
  for (const [eventName, selected] of [
    ["buzz:next-tab", thread],
    ["buzz:previous-tab", notes],
  ] as const) {
    h.composer.focus();
    const event = new Event(eventName, { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(selected).toHaveAttribute("aria-selected", "true");
  }
  h.composer.focus();
  expect(closeTabs("buzz:close-active-tab")).toBe(true);
  expect(notes).not.toBeInTheDocument();
  expect(thread).toHaveFocus();
});

it("leaves Shift+Escape (Mark all as read) to a side thread, closing it on Escape", async () => {
  const h = await page();
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  const root = "c".repeat(64);
  act(() =>
    tabs.result.current.openThreadTab("alpha", root, root, undefined, "side"),
  );
  const thread = await screen.findByRole("tab", { name: "Thread · Alpha" });
  expect(thread).toHaveAttribute("aria-selected", "true");
  const content = document.querySelector(
    `[id="${thread.getAttribute("aria-controls")}"] *`,
  );
  if (!content) throw new Error("The side thread has no content");
  fireEvent.keyDown(content, { key: "Escape", shiftKey: true });
  expect(thread).toBeInTheDocument();
  fireEvent.keyDown(content, { key: "Escape" });
  expect(thread).not.toBeInTheDocument();
});

it.each(["stream", "solo"] as const)(
  "the real %s page closes its side tabs by shortcut, preserves typing, and handles an empty repeat",
  async (type) => {
    const h = await page(type);
    await h.open();
    expect(
      screen.getByRole("tab", {
        name: "Notes",
      }),
    ).toBeInTheDocument();
    h.composer.focus();
    await h.user.keyboard("Keep typing");
    const modal = document.createElement("dialog");
    modal.open = true;
    document.body.append(modal);
    closeTabs();
    modal.remove();
    expect(
      screen.getByRole("tab", {
        name: "Notes",
      }),
    ).toBeInTheDocument();
    expect(closeTabs()).toBe(true);
    expect(
      screen.queryByRole("tab", {
        name: "Notes",
      }),
    ).not.toBeInTheDocument();
    expect(h.composer).toHaveFocus();
    expect(h.composer).toHaveTextContent("Keep typing");
    closeTabs();
    expect(h.composer).toHaveFocus();
    expect(h.composer).toHaveTextContent("Keep typing");
  },
);

it.each(["stream", "solo"] as const)(
  "the real %s page returns focus when the menu's owning tab closes",
  async (type) => {
    const h = await page(type);
    await h.open();
    const notes = screen.getByRole("tab", {
      name: "Notes",
    });
    await h.user.pointer({ target: notes, keys: "[MouseRight]" });
    await h.user.click(
      await screen.findByRole("menuitem", { name: "Close all tabs" }),
    );
    expect(
      screen.queryByRole("tab", {
        name: "Notes",
      }),
    ).not.toBeInTheDocument();
    if (type === "stream")
      expect(
        screen.getByRole("button", { name: "Manage members of Alpha" }),
      ).toHaveFocus();
    else
      expect(screen.getByRole("region", { name: "Chat Alpha" })).toHaveFocus();
  },
);

it("an empty tab menu returns keyboard focus to the conversation identity", async () => {
  const h = await page();
  const channel = screen.getByRole("button", {
    name: "Manage members of Alpha",
  });
  channel.focus();
  await h.user.keyboard("{Shift>}{F10}{/Shift}");
  const action = await screen.findByRole("menuitem", {
    name: "Close all tabs",
  });
  action.focus();
  await h.user.keyboard("{Enter}");
  expect(
    await screen.findByRole("button", { name: "Manage members of Alpha" }),
  ).toHaveFocus();
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
});

it("the conversation identity menu clears the page's side tabs too", async () => {
  const h = await page();
  await h.open();
  const channel = screen.getByRole("button", {
    name: "Manage members of Alpha",
  });
  await h.user.pointer({ target: channel, keys: "[MouseRight]" });
  await h.user.click(
    await screen.findByRole("menuitem", { name: "Close all tabs" }),
  );
  expect(screen.queryByRole("tab", { name: "Notes" })).not.toBeInTheDocument();
  expect(channel).toHaveFocus();
});

it("close-all works while a main-pane thread covers the channel conversation", async () => {
  const h = await page();
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  const root = "a".repeat(64);
  act(() =>
    tabs.result.current.openThreadTab("alpha", root, root, undefined, "main"),
  );
  expect(
    within(screen.getByRole("tablist", { name: "Channel tabs" })).getAllByRole(
      "tab",
    ),
  ).toHaveLength(2);
  expect(closeTabs()).toBe(true);
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(
    screen.getByRole("button", { name: "Manage members of Alpha" }),
  ).toHaveFocus();
});

it.each([false, true])(
  "closing a side tab from the composer keeps typing and Enter there (another side tab=%s)",
  async (anotherTab) => {
    const h = await page();
    if (anotherTab) {
      const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
      const root = "b".repeat(64);
      act(() =>
        tabs.result.current.openThreadTab(
          "alpha",
          root,
          root,
          undefined,
          "side",
        ),
      );
    }
    await h.open();
    expect(screen.getByRole("tab", { name: "Notes" })).toBeInTheDocument();
    h.composer.focus();
    expect(closeTabs("buzz:close-active-tab")).toBe(true);
    expect(
      screen.queryByRole("tab", { name: "Notes" }),
    ).not.toBeInTheDocument();
    expect(h.composer).toHaveFocus();
    await h.user.keyboard("{Enter}");
    expect(
      screen.queryByRole("tab", { name: "Notes" }),
    ).not.toBeInTheDocument();
    expect(h.composer).toHaveFocus();
    await h.user.keyboard("Keep typing");
    expect(h.composer).toHaveTextContent("Keep typing");
  },
);

it.each(["side", "main"] as const)(
  "closing others from a %s tab keeps focus on it while the other pane's selected tab closes",
  async (kept) => {
    const h = await page();
    const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
    const root = "c".repeat(64);
    act(() =>
      tabs.result.current.openThreadTab("alpha", root, root, undefined, "main"),
    );
    await h.open();
    const main = within(screen.getByRole("tablist", { name: "Channel tabs" }));
    const thread = main.getAllByRole("tab")[1];
    if (!thread) throw new Error("missing main-pane thread tab");
    expect(thread).toHaveAttribute("aria-selected", "true");
    const target =
      kept === "side" ? screen.getByRole("tab", { name: "Notes" }) : thread;
    await h.user.pointer({ target, keys: "[MouseRight]" });
    await h.user.click(
      await screen.findByRole("menuitem", { name: "Close other tabs" }),
    );
    expect(screen.getAllByRole("tab")).toHaveLength(kept === "side" ? 1 : 2);
    expect(target).toBeInTheDocument();
    expect(target).toHaveAttribute("aria-selected", "true");
    expect(target).toHaveFocus();
  },
);

it("gives a Solo chat's side tab its own header actions, opening it in the main view", async () => {
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const h = await page("stream", {
    open,
    snapshot: () => visitSnapshot,
  } as unknown as Navigation);
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  act(() =>
    tabs.result.current.setTabs((items) => [
      ...items,
      { id: "conversation:beta", kind: "conversation", channelId: "beta" },
      { id: "conversation:gamma", kind: "conversation", channelId: "gamma" },
    ]),
  );
  await h.user.click(await screen.findByRole("tab", { name: "Gamma" }));
  expect(
    await screen.findByRole("button", { name: "Share access" }),
  ).toBeInTheDocument();
  await h.user.click(screen.getByRole("button", { name: "Chat actions" }));
  const menu = within(
    await screen.findByRole("menu", { name: "Chat actions" }),
  );
  expect(menu.getAllByRole("menuitem")[0]).toHaveTextContent(
    "Open in main view",
  );
  // No host beside another conversation can finish a conversion.
  expect(
    menu.queryByRole("menuitem", { name: "Convert to channel" }),
  ).toBeNull();
  await h.user.click(menu.getByRole("menuitem", { name: "Open in main view" }));
  await vi.waitFor(() =>
    expect(open).toHaveBeenLastCalledWith({
      version: 1,
      kind: "conversation",
      scope: {
        viewer: h.viewer,
        communityOrigin: h.scope.slice(0, -(h.viewer.length + 1)),
      },
      channelId: "gamma",
    }),
  );
  // A team channel's tab keeps the panel's own header.
  await h.user.click(screen.getByRole("tab", { name: "Beta" }));
  expect(screen.queryByRole("button", { name: "Chat actions" })).toBeNull();
});

it("keeps a side tab's failed move recoverable after switching tabs", async () => {
  const base = {
    status: "ready",
    data: {
      sections: [{ id: "work", name: "Work", order: 0 }],
      assignments: {},
      starred: [],
      muted: [],
    },
  } as unknown as ReturnType<RelaySession["soloPreferences"]["snapshot"]>;
  let current = base;
  const listeners = new Set<() => void>();
  const publish = (next: typeof current) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const failed = {
    ...base,
    moves: [
      {
        id: 1,
        channelId: "gamma",
        destination: { sectionId: "work" },
        pending: false,
        error: "Relay unavailable",
      },
    ],
  } as unknown as typeof current;
  const retryMove = vi.fn(() => new Promise<never>(() => {}));
  const h = await page(
    "stream",
    {
      open: vi.fn(async () => ({ status: "opened" as const })),
      snapshot: () => visitSnapshot,
    } as unknown as Navigation,
    false,
    undefined,
    {
      writable: true,
      snapshot: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      assign: vi.fn(async () => {
        publish(failed);
        throw new Error("Relay unavailable");
      }),
      retryMove,
    } as unknown as RelaySession["soloPreferences"],
  );
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  act(() =>
    tabs.result.current.setTabs((items) => [
      ...items,
      { id: "conversation:beta", kind: "conversation", channelId: "beta" },
      { id: "conversation:gamma", kind: "conversation", channelId: "gamma" },
    ]),
  );
  await h.user.click(await screen.findByRole("tab", { name: "Gamma" }));
  await h.user.click(
    await screen.findByRole("button", { name: "Chat actions" }),
  );
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await h.user.keyboard("{ArrowRight}");
  await h.user.click(await screen.findByRole("menuitem", { name: "Work" }));
  expect(await screen.findByText("Chat wasn’t moved")).toBeVisible();
  // Gamma's toolbar unmounts, but the page still owns its recovery.
  await h.user.click(screen.getByRole("tab", { name: "Beta" }));
  expect(screen.queryByRole("button", { name: "Chat actions" })).toBeNull();
  expect(screen.getByText("Chat wasn’t moved")).toBeVisible();
  // Toasts own swipe gestures, so press their buttons without a pointer.
  fireEvent.click(screen.getByRole("button", { name: "Retry move" }));
  expect(retryMove).toHaveBeenCalledExactlyOnceWith("gamma");
  // Settled elsewhere, as by the sidebar's Dismiss, the move is no longer the
  // header's: a later failure it did not start raises no toast.
  act(() => publish(base));
  await vi.waitFor(() =>
    expect(screen.queryByText("Chat wasn’t moved")).toBeNull(),
  );
  act(() => publish(failed));
  expect(screen.queryByText("Chat wasn’t moved")).toBeNull();
});

it("keeps a newer header move recoverable after an earlier one succeeds", async () => {
  const base = {
    status: "ready",
    data: {
      sections: [
        { id: "work", name: "Work", order: 0 },
        { id: "home", name: "Home", order: 1 },
      ],
      assignments: {},
      starred: [],
      muted: [],
    },
  } as unknown as ReturnType<RelaySession["soloPreferences"]["snapshot"]>;
  let current = base;
  const listeners = new Set<() => void>();
  const publish = (next: typeof current) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const move = (
    id: number,
    sectionId: string,
    state: { pending: true } | { pending: false; error: string },
  ) => ({ id, channelId: "gamma", destination: { sectionId }, ...state });
  const withMoves = (...moves: ReturnType<typeof move>[]) =>
    ({ ...base, moves }) as unknown as typeof current;
  // The store queues both writes; each settles only when the test says so.
  const settle: {
    resolve(): void;
    reject(error: Error): void;
  }[] = [];
  const queued: ReturnType<typeof move>[] = [];
  const assign = vi.fn(
    (_channelId: string, sectionId = "") =>
      new Promise<void>((resolve, reject) => {
        settle.push({ resolve, reject });
        queued.push(move(settle.length, sectionId, { pending: true }));
        publish(withMoves(...queued));
      }),
  );
  const h = await page(
    "stream",
    {
      open: vi.fn(async () => ({ status: "opened" as const })),
      snapshot: () => visitSnapshot,
    } as unknown as Navigation,
    false,
    undefined,
    {
      writable: true,
      snapshot: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      assign,
      retryMove: vi.fn(() => new Promise<never>(() => {})),
    } as unknown as RelaySession["soloPreferences"],
  );
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  act(() =>
    tabs.result.current.setTabs((items) => [
      ...items,
      { id: "conversation:gamma", kind: "conversation", channelId: "gamma" },
    ]),
  );
  await h.user.click(await screen.findByRole("tab", { name: "Gamma" }));
  const moveTo = async (name: string) => {
    await h.user.click(
      await screen.findByRole("button", { name: "Chat actions" }),
    );
    (await screen.findByRole("menuitem", { name: "Move to" })).focus();
    await h.user.keyboard("{ArrowRight}");
    await h.user.click(await screen.findByRole("menuitem", { name }));
  };
  await moveTo("Work");
  await moveTo("Home");
  expect(settle).toHaveLength(2);
  // The earlier move succeeds while the newer one is still queued.
  await act(async () => {
    publish(withMoves(move(2, "home", { pending: true })));
    settle[0]?.resolve();
  });
  await act(async () => {
    publish(
      withMoves(
        move(2, "home", { pending: false, error: "Relay unavailable" }),
      ),
    );
    settle[1]?.reject(new Error("Relay unavailable"));
  });
  expect(await screen.findByText("Chat wasn’t moved")).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry move" })).toBeVisible();
});

it("opens another conversation's tab in its channel, but not the current channel's threads", async () => {
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const h = await page("stream", {
    open,
    snapshot: () => visitSnapshot,
  } as unknown as Navigation);
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  const root = "d".repeat(64);
  act(() => {
    tabs.result.current.openThreadTab("alpha", root, root, undefined, "side");
    tabs.result.current.setTabs((items) => [
      ...items,
      { id: "conversation:beta", kind: "conversation", channelId: "beta" },
    ]);
  });
  const menu = async (name: string) => {
    await h.user.pointer({
      target: await screen.findByRole("tab", { name }),
      keys: "[MouseRight]",
    });
    return within(await screen.findByRole("menu"));
  };
  expect(
    (await menu("Thread · Alpha")).queryByRole("menuitem", {
      name: "Open in channel",
    }),
  ).not.toBeInTheDocument();
  await h.user.keyboard("{Escape}");
  await h.user.click(
    (await menu("Beta")).getByRole("menuitem", { name: "Open in channel" }),
  );
  const scope = {
    viewer: h.viewer,
    communityOrigin: h.scope.slice(0, -(h.viewer.length + 1)),
  };
  await vi.waitFor(() =>
    expect(open).toHaveBeenLastCalledWith({
      version: 1,
      kind: "conversation",
      scope,
      channelId: "beta",
    }),
  );
  // A tab whose id was taken keeps its root before a suffix in its own id.
  const other = "e".repeat(64);
  act(() =>
    tabs.result.current.setTabs((items) => [
      ...items,
      {
        id: `thread:beta:${other}:${crypto.randomUUID()}`,
        kind: "thread",
        channelId: "beta",
        messageId: other,
      },
    ]),
  );
  await h.user.click(
    (await menu("Thread · Beta")).getByRole("menuitem", {
      name: "Open in channel",
    }),
  );
  await vi.waitFor(() =>
    expect(open).toHaveBeenLastCalledWith({
      version: 1,
      kind: "conversation",
      scope,
      channelId: "beta",
      messageId: other,
      threadRootId: other,
      context: "channel",
    }),
  );
});
