// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import type { InboxItem } from "../../features/relay/inbox";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { SharedChatRows } from "./SharedChatRows";
import { updateArchive } from "./archive";

afterEach(cleanup);

const viewer = "a".repeat(64);
const owner = "b".repeat(64);
const scope = `wss://relay.example:${viewer}`;

function fixture() {
  const listeners = new Set<() => void>();
  const notify = () =>
    act(() => {
      for (const listener of listeners) listener();
    });
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const solo = (id: string, name: string, creator: string) => ({
    id,
    name,
    channelType: "solo",
    creator,
  });
  const list = {
    status: "ready",
    channels: [
      solo("shared", "Alex's API question", owner),
      solo("quiet", "Shared but untagged", owner),
      solo("mine", "My own chat", viewer),
    ],
  };
  let items: InboxItem[] = [];
  let sequence = 0;
  let inbox = { status: "ready", items, freshness: "observed" };
  const session = {
    scope,
    channels: { list: () => list, subscribeList: subscribe, ensureList() {} },
    unread: { inbox: () => inbox, subscribeInbox: subscribe },
  } as unknown as RelaySession;
  const relaySnapshot = {
    status: "ready",
    generation: 1,
    scope,
    viewer,
    session,
  };
  const relay = {
    snapshot: () => relaySnapshot,
    subscribe,
  } as unknown as RelayData;
  let target: OpenTarget = {
    version: 1,
    kind: "page",
    pluginId: "buzz.inbox",
    pageId: "inbox",
  } as OpenTarget;
  const open = vi.fn<Navigation["open"]>(async () => ({ status: "opened" }));
  const navigator = {
    snapshot: () => ({ entry: { target } }),
    subscribe,
    open,
  } as unknown as Navigation;
  return {
    view: <SharedChatRows relay={relay} navigator={navigator} />,
    open,
    tag(channelId: string, unreadCount: number, manual = false) {
      const id = (++sequence).toString(16).padStart(64, "0");
      const messages = [{ id, createdAt: 2e9 + sequence, mentioned: true }];
      items = [
        ...items.filter((item) => item.channelId !== channelId),
        {
          id: `${channelId}:${channelId}`,
          channelId,
          target: { kind: "message", channelId, messageId: id },
          messageIds: messages.map((message) => message.id),
          messages,
          thread: false,
          unreadCount,
          manual,
        } as unknown as InboxItem,
      ];
      inbox = { ...inbox, items };
      notify();
    },
    archive(channelId: string) {
      const item = items.find((item) => item.channelId === channelId);
      if (!item) throw new Error(`No inbox item for ${channelId}`);
      act(() => updateArchive(scope, item, true));
    },
    go(channelId?: string) {
      target = channelId
        ? ({ version: 1, kind: "conversation", channelId } as OpenTarget)
        : ({
            version: 1,
            kind: "page",
            pluginId: "buzz.inbox",
            pageId: "inbox",
          } as OpenTarget);
      notify();
    },
  };
}

const names = () =>
  screen.queryAllByRole("button").map((row) => row.textContent);

it("pulls in someone else's chat only while it has an unread tag or stays open after one", async () => {
  const h = fixture();
  render(h.view);
  expect(names()).toEqual([]);

  // A tag in the viewer's own chat, a quiet share, or marking an untagged
  // message unread never adds a row.
  h.tag("mine", 1);
  h.tag("quiet", 0, true);
  expect(names()).toEqual([]);

  h.tag("shared", 2);
  expect(names()).toEqual(["Alex's API question"]);

  await userEvent.click(
    screen.getByRole("button", { name: "Alex's API question" }),
  );
  expect(h.open).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "conversation", channelId: "shared" }),
  );
  h.go("shared");
  expect(
    screen.getByRole("button", { name: "Alex's API question" }),
  ).toHaveAttribute("aria-current", "page");

  // Reading it keeps the row while it stays open, then moving on clears it.
  h.tag("shared", 0);
  expect(names()).toEqual(["Alex's API question"]);
  h.go();
  expect(names()).toEqual([]);

  // A shared chat opened without a tag, from a card or link, adds nothing.
  h.go("quiet");
  expect(names()).toEqual([]);

  // The next tag brings it back; archiving it in Inbox clears it unopened,
  // until a newer tag.
  h.tag("shared", 1);
  expect(names()).toEqual(["Alex's API question"]);
  h.archive("shared");
  expect(names()).toEqual([]);
  h.tag("shared", 2);
  expect(names()).toEqual(["Alex's API question"]);
});
