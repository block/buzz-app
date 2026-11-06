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
import type { ReactElement, ReactNode } from "react";
import { npubEncode } from "nostr-tools/nip19";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import { conversationTarget } from "../../features/channel-navigation/routes";
import type { PageNavigation } from "../../features/navigation/service";
import type { OpenTarget } from "../../features/navigation/targets";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
import { createRelaySession } from "../../features/relay/session";
import {
  bounds,
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
} from "../../features/relay/testing";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { PageTabTarget } from "../../features/conversation/contracts";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { writeView } from "../../shared/view-state";
import { ChannelsPage } from "./ChannelsPage";
import { PageTabs } from "./PageTabs";

// jsdom has no layout, so the virtualizer would mount no rows. Geometry is the
// only thing replaced: every row mounts, in order.
vi.mock("virtua", async () => {
  const { Children, forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      { children }: { children: ReactNode },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        cache: undefined,
        findItemIndex: () => 0,
        getItemOffset: () => 0,
        scrollOffset: 0,
        scrollSize: 0,
        viewportSize: 0,
        scrollTo() {},
        scrollToIndex() {},
      }));
      return (
        <ol>
          {Children.toArray(children).map((child) => (
            <li key={(child as ReactElement).key}>{child}</li>
          ))}
        </ol>
      );
    }),
  };
});

stubAvatarBrowserApis();
composerDOMFixture();

const owners: ReturnType<typeof createRelaySession>[] = [];
const frames: FrameRequestCallback[] = [];
beforeEach(() => {
  // jsdom has no layout. Only geometry and frame timing are substituted; the
  // page, review, session, tab store and focus handoffs are production owners.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = () => {};
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
});
afterEach(() => {
  cleanup();
  frames.length = 0;
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const empty: readonly never[] = [];
const contributions = { snapshot: () => empty, subscribe: () => () => {} };
const extensions = { tools: contributions, inline: contributions };
const channelId = "11111111-1111-4111-8111-111111111111";
const image = { kind: "image" as const, url: "https://fixture.test/image.png" };

/** Runs the frame callbacks a focus handoff scheduled, until none remain. */
async function flushFrames() {
  await act(async () => {});
  for (let round = 0; round < 5 && frames.length; round++) {
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0);
    });
  }
}

/** Channels with an image post, Sam's comment on it, and a second message. */
async function channels(comment: (target: string) => string) {
  const viewer = keypair(),
    authority = keypair(),
    sam = keypair();
  const root = message(viewer, channelId, "Image", 1_700_000_001, [
    ["imeta", `url ${image.url}`, "m image/png"],
  ]);
  const other = message(viewer, channelId, "Linked message", 1_700_000_003);
  const target = `buzz://message?channel=${channelId}&id=${other.id}&thread=${other.id}`;
  const reply = message(sam, channelId, comment(target), 1_700_000_002, [
    ["e", root.id, "", "reply"],
  ]);
  const directory = [
    roster(authority, channelId, [viewer.pubkey]),
    metadata(authority, channelId, "Alpha", undefined, [["t", "stream"]]),
    profile(viewer, { name: "Human" }),
    profile(sam, { name: "Sam" }),
  ];
  const posts = [root, reply, other];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: authority.pubkey,
      media: (url) => url,
      scope: "https://fixture.test",
      query: async (filters) =>
        filters.flatMap((filter) => {
          if (filter.ids)
            return posts.filter((event) => filter.ids?.includes(event.id));
          if (filter.top_level)
            return [
              root,
              other,
              bounds(authority, channelId, "head", {
                has_more: false,
                next_cursor: null,
              }),
            ];
          if (filter.depth_limit)
            return filter.thread_cursor === undefined ? [reply] : [];
          return directory.filter(
            (event) =>
              filter.kinds?.includes(event.kind) &&
              (event.kind !== 0 || filter.authors?.includes(event.pubkey)),
          );
        }),
      writer: {
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  owners.push(owner);
  const scope = `https://fixture.test:${viewer.pubkey}`;
  writeView(scope, "selected-channel", channelId);
  owner.session.channels.ensureList();
  await waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  await waitFor(() =>
    expect(owner.session.channels.list().channels).toHaveLength(1),
  );
  return {
    owner,
    scope,
    viewer: viewer.pubkey,
    sam: sam.pubkey,
    target,
    rootId: root.id,
  };
}

async function mount(h: Awaited<ReturnType<typeof channels>>) {
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: h.scope,
    viewer: h.viewer,
    session: h.owner.session,
  };
  const profileTarget = `nostr:${npubEncode(h.sam)}`;
  const profilePanel: RegisteredPanel = {
    id: "profile",
    key: "fixture:profile",
    pluginId: "fixture",
    revision: "1",
    title: "Profile",
    matches: (target) => target === profileTarget,
    component: () => <input aria-label="Profile note" />,
  };
  const available = [profilePanel];
  let handleOpen: Parameters<Panels["handleOpenRequests"]>[0] | undefined;
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
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const navigator = createNavigationController(
    createMemoryHistory(),
  ).navigation;
  const page = (entryId: string, target: OpenTarget) => {
    const navigation: PageNavigation = {
      entryId,
      target,
      signal: new AbortController().signal,
      position: () => undefined,
      savePosition() {},
      passThrough: () => () => {},
      forSession: () => navigation,
      complete: () => true,
      resolve: () => true,
    };
    return (
      <ToastProvider>
        <ChannelsPage
          relay={relay}
          panels={panels}
          extensions={extensions}
          navigator={navigator}
          navigation={navigation}
        />
      </ToastProvider>
    );
  };
  const { rerender } = render(
    page("visit", conversationTarget(h.scope, channelId)),
  );
  /** Shows what the page asked the navigator for, as the page host does. */
  const follow = async () => {
    const { entry } = navigator.snapshot();
    expect(entry.target).toMatchObject({ threadRootId: expect.any(String) });
    rerender(page(entry.id, entry.target));
    await flushFrames();
  };
  const attachment = await screen.findByRole("link", {
    name: "Open image attachment",
  });
  // From here focus handoffs are flushed explicitly, not by wall-clock frames.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  // Focus is on the image when it opens the review.
  attachment.focus();
  expect(attachment).toHaveFocus();
  fireEvent.click(attachment);
  const review = await screen.findByRole("dialog", { name: "Image viewer" });
  const comments = await within(review).findByRole("region", {
    name: "Media comments",
  });
  await flushFrames();
  return { attachment, comments, follow };
}

it("returns focus to the image that opened the review when its profile tab closes", async () => {
  const h = await channels(() => "Looks good");
  const { attachment, comments } = await mount(h);
  fireEvent.click(
    await within(comments).findByRole("button", { name: "View Sam profile" }),
  );
  await flushFrames();
  expect(screen.queryByRole("dialog", { name: "Image viewer" })).toBeNull();
  expect(await screen.findByRole("tab", { name: "Profile" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Close Profile tab" }));
  await flushFrames();
  expect(screen.queryByRole("tab", { name: "Profile" })).toBeNull();
  await waitFor(() => expect(attachment).toHaveFocus());
});

it("returns focus to the image that opened the review when a followed message's thread tab closes", async () => {
  const h = await channels((target) => `See <${target}>`);
  const { attachment, comments } = await mount(h);
  const link = within(comments).getByRole("link");
  fireEvent.contextMenu(link);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Open link" }));
  await flushFrames();
  expect(screen.queryByRole("dialog", { name: "Image viewer" })).toBeNull();
  const tab = await screen.findByRole("tab", { name: /Linked message/ });
  expect(tab).toHaveAttribute("aria-selected", "true");

  fireEvent.click(
    screen.getByRole("button", { name: /^Close .*Linked message.* tab$/ }),
  );
  await flushFrames();
  expect(screen.queryByRole("tab", { name: /Linked message/ })).toBeNull();
  await waitFor(() => expect(attachment).toHaveFocus());
});

it("returns focus to the image that opened the review when a followed message link's thread closes", async () => {
  const h = await channels((target) => `See <${target}>`);
  const { attachment, comments, follow } = await mount(h);
  fireEvent.click(within(comments).getByRole("link"));
  await flushFrames();
  expect(screen.queryByRole("dialog", { name: "Image viewer" })).toBeNull();
  await follow();
  const tab = await screen.findByRole("tab", { name: /Linked message/ });
  expect(tab).toHaveAttribute("aria-selected", "true");

  fireEvent.click(
    screen.getByRole("button", { name: /^Close .*Linked message.* tab$/ }),
  );
  await flushFrames();
  expect(screen.queryByRole("tab", { name: /Linked message/ })).toBeNull();
  await waitFor(() => expect(attachment).toHaveFocus());
});

/** Activity's tab workspace with the image post's thread moved to its main
 * pane, and that thread's image review open. */
async function activity(h: Awaited<ReturnType<typeof channels>>) {
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: h.scope,
    viewer: h.viewer,
    session: h.owner.session,
  };
  const host = {
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    panels: {
      snapshot: () => empty,
      subscribe: () => () => {},
      resolve: () => undefined,
    },
    navigation: { open: vi.fn() },
  } as unknown as ConversationHostServices;
  let open: (target: PageTabTarget) => boolean = () => false;
  render(
    <ToastProvider>
      <PageTabs
        id="inbox"
        session={h.owner.session}
        scope={h.scope}
        label="Activity"
        host={host}
        extensions={extensions}
        visits={false}
      >
        {(next) => {
          open = next;
          return <p>Activity list</p>;
        }}
      </PageTabs>
    </ToastProvider>,
  );
  act(() => {
    expect(open({ channelId, threadId: h.rootId })).toBe(true);
  });
  const thread = within(
    await screen.findByRole("tablist", { name: "Panel tabs" }),
  ).getByRole("tab");
  act(() => {
    fireEvent.keyDown(thread, {
      key: "ArrowLeft",
      altKey: true,
      shiftKey: true,
    });
  });
  expect(
    within(screen.getByRole("tablist", { name: "Activity tabs" }))
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual(["Activity", "Thread · Alpha"]);
  expect(screen.queryByRole("tablist", { name: "Panel tabs" })).toBeNull();
  const attachment = await screen.findByRole("link", {
    name: "Open image attachment",
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  attachment.focus();
  expect(attachment).toHaveFocus();
  fireEvent.click(attachment);
  const review = await screen.findByRole("dialog", { name: "Image viewer" });
  const comments = await within(review).findByRole("region", {
    name: "Media comments",
  });
  await flushFrames();
  return { attachment, comments };
}

it("returns focus to the image in Activity's main pane when a followed message's only side thread closes", async () => {
  const h = await channels((target) => `See <${target}>`);
  const { attachment, comments } = await activity(h);
  fireEvent.contextMenu(await within(comments).findByRole("link"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Open link" }));
  await flushFrames();
  expect(screen.queryByRole("dialog", { name: "Image viewer" })).toBeNull();
  // The followed message's thread is the side pane's only tab.
  const side = await screen.findByRole("tablist", { name: "Panel tabs" });
  const tab = within(side).getByRole("tab");
  expect(tab).toHaveAttribute("aria-selected", "true");
  const workspace = side.closest<HTMLElement>("[data-panel-workspace]");
  expect(workspace).not.toBeNull();

  fireEvent.click(
    within(workspace as HTMLElement).getByRole("button", {
      name: /^Close .* tab$/,
    }),
  );
  await flushFrames();
  expect(screen.queryByRole("tablist", { name: "Panel tabs" })).toBeNull();
  expect(attachment).toBeInTheDocument();
  await waitFor(() => expect(attachment).toHaveFocus());
});
