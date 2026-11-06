// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import type { RelayEvent } from "../../features/relay/events";
import { matchesEvent } from "../../features/relay/projection";
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
import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import { PageTabs } from "../channels/PageTabs";
import { InboxPage } from "./InboxPage";

// jsdom has no virtualized layout. Keep the real rows, thread reader and React
// lifecycle; model only Virtua's imperative layout boundary, not scroll behavior.
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
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
      return <div>{children}</div>;
    }),
  };
});

composerDOMFixture();
stubAvatarBrowserApis();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.restoreAllMocks();
});

function fixture() {
  const viewer = keypair(),
    alice = keypair(),
    relayKey = keypair();
  const mention = message(alice, "room", "Please review **this**", 21, [
    ["p", viewer.pubkey],
  ]);
  const events = [
    roster(relayKey, "room", [viewer.pubkey, alice.pubkey], 10),
    metadata(relayKey, "room", "Design", 10, [
      ["t", "stream"],
      ["private"],
      ["t", "buzz.solo"],
    ]),
    profile(alice, { name: "Alice" }),
    mention,
  ];
  const published: RelayEvent[] = [];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relayKey.pubkey,
      media: () => undefined,
      query: async (filters) =>
        filters.flatMap((filter) => [
          ...events.filter((event) => matchesEvent(event, filter)),
          ...(filter.top_level && filter["#h"]?.[0]
            ? [
                bounds(relayKey, filter["#h"][0], "head", {
                  has_more: false,
                  next_cursor: null,
                }),
              ]
            : []),
        ]),
      writer: {
        kinds: [9, 9007],
        sign: async (template) => signed(viewer, template),
        publish: async (event) => {
          published.push(event);
        },
      },
      subscribe(callbacks) {
        callbacks.state({ status: "connected", routes: [] });
        callbacks.receive(events);
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { readStateFloor: () => 0, outboxStorage: { load: () => [], save() {} } },
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
    clearCache: owner.clearCache,
  };
  const empty: readonly never[] = [];
  const navigator = createNavigationController(
    createMemoryHistory(),
  ).navigation;
  const host: ConversationHostServices = {
    relay,
    navigation: navigator,
    panels: {
      subscribe: () => () => {},
      snapshot: () => empty,
      resolve: () => undefined,
      register() {},
      requestOpen: () => false,
      handleOpenRequests: () => () => {},
    },
  };
  return {
    mention,
    published,
    view: (
      <StrictMode>
        <InboxPage
          tabs={(props) => <PageTabs {...props} host={host} />}
          relay={relay}
          navigator={navigator}
        />
      </StrictMode>
    ),
  };
}

it("holding a message in an Inbox conversation targets a thread reply", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Mentions" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Alice in Design" }));
  const editor = await screen.findByRole("textbox", {
    name: "Message this conversation",
  });
  const row = await waitFor(() => {
    const element = document.querySelector(
      `[data-message-id="${h.mention.id}"] p`,
    );
    if (!element) throw Error("Missing preview message");
    return element;
  });
  await user.pointer({ target: row, keys: "[MouseLeft>]" });
  await screen.findByRole("button", { name: "Cancel reply target" });
  await user.pointer({ keys: "[/MouseLeft]" });
  expect(editor.isConnected).toBe(true);
  fireEvent.change(editor, { target: { value: "Reply from Inbox" } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(h.published).toHaveLength(1));
  expect(h.published[0]?.tags).toContainEqual(["e", h.mention.id, "", "reply"]);
});
