import { expect, it, vi } from "vitest";
import type { InboxItem } from "../../features/relay/inbox";
import type { RelaySession } from "../../features/relay/session";
import { apply } from "./index";
import { recentConversations, recentIds, stepRecent } from "./recent";

const item = (
  channelId: string,
  messageId: string,
  createdAt: number,
  rootId?: string,
) =>
  ({ channelId, messageId, createdAt, ...(rootId && { rootId }) }) as InboxItem;
function session(items: InboxItem[]) {
  const listeners = new Set<() => void>();
  let inbox = { items };
  const ensure = vi.fn(async () => {});
  return {
    ensure,
    value: {
      viewer: "v",
      inboxFeed: { ensure },
      channels: {
        list: () => ({
          status: "ready",
          channels: [
            { id: "alpha", channelType: "stream" },
            { id: "beta", channelType: "stream" },
            { id: "gamma" },
            { id: "dm", channelType: "dm", lastActivityAt: 70 },
            {
              id: "muted",
              channelType: "dm",
              hidden: true,
              lastActivityAt: 3,
            },
            { id: "silent", channelType: "dm" },
            { id: "forum", channelType: "forum" },
            { id: "chat", channelType: "solo", lastActivityAt: 65 },
            { id: "quiet", channelType: "solo", updatedAt: 5 },
            {
              id: "watched",
              channelType: "solo",
              readOnly: true,
              lastActivityAt: 99,
            },
            {
              id: "shelved",
              channelType: "solo",
              archived: true,
              lastActivityAt: 98,
            },
            { id: "hidden", channelType: "stream", hidden: true },
            { id: "old", channelType: "stream", archived: true },
            { id: "call", channelType: "stream", huddle: true },
          ],
        }),
        subscribeList: () => () => {},
      },
      unread: {
        inbox: () => inbox,
        subscribeInbox(listener: () => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    } as unknown as RelaySession,
    publish(next: InboxItem[]) {
      inbox = { items: next };
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

it("ranks Solo chats and DMs by activity with Team channels by their newest inbox item, read or not", () => {
  const { value } = session([
    item("dm", "1", 90),
    item("beta", "2", 80, "root"),
    item("forum", "3", 70),
    item("alpha", "4", 60),
    item("beta", "5", 50),
    item("chat", "6", 45),
    item("gamma", "7", 40),
    item("gone", "8", 30),
    item("hidden", "9", 20),
    item("old", "10", 10),
    item("call", "11", 1),
  ]);
  expect(recentConversations(value)).toEqual([
    { channelId: "beta", at: 80, messageId: "2", rootId: "root" },
    { channelId: "dm", at: 70 },
    { channelId: "chat", at: 65 },
    { channelId: "alpha", at: 60, messageId: "4" },
    { channelId: "gamma", at: 40, messageId: "7" },
    { channelId: "quiet", at: 5 },
    { channelId: "muted", at: 3 },
  ]);
});

it("loads Inbox's mention history and publishes the same IDs until they change", () => {
  const fake = session([item("alpha", "1", 70), item("beta", "2", 68)]);
  const source = recentIds(fake.value);
  const listener = vi.fn();
  const stop = source.subscribe(listener);
  expect(fake.ensure).toHaveBeenCalled();
  const first = source.snapshot();
  expect(first).toEqual(["alpha", "dm", "beta", "chat", "quiet", "muted"]);
  fake.publish([item("alpha", "3", 71), item("beta", "2", 68)]);
  expect(listener).toHaveBeenCalled();
  expect(source.snapshot()).toBe(first);
  fake.publish([item("beta", "4", 72), item("alpha", "3", 71)]);
  expect(source.snapshot()).toEqual([
    "beta",
    "alpha",
    "dm",
    "chat",
    "quiet",
    "muted",
  ]);
  stop();
  expect(fake.listeners.size).toBe(0);
});

it("steps down and up through the shown items, wrapping", () => {
  const items = ["a", "b", "c"].map((channelId) => ({ channelId, at: 0 }));
  const down = (current: string | undefined, limit = 8) =>
    stepRecent(items, current, limit, 1)?.channelId;
  const up = (current: string | undefined, limit = 8) =>
    stepRecent(items, current, limit, -1)?.channelId;
  expect(down(undefined)).toBe("a");
  expect(down("a")).toBe("b");
  expect(down("c")).toBe("a");
  expect(down("b", 2)).toBe("a");
  expect(down("c", 2)).toBe("a");
  expect(up(undefined)).toBe("c");
  expect(up("b")).toBe("a");
  expect(up("a")).toBe("c");
  expect(up("c", 2)).toBe("b");
  expect(stepRecent([], "a", 8, 1)).toBeUndefined();
  expect(stepRecent([], "a", 8, -1)).toBeUndefined();
});

it("⌘D opens the following channel at the thread that listed it, ⌘U the one before", () => {
  const fake = session([item("alpha", "1", 90), item("beta", "2", 80, "root")]);
  const shortcuts = { register: vi.fn() };
  const conversation = { registerConversationSection: vi.fn() };
  const open = vi.fn(async () => ({ status: "opened" }));
  const scope = { communityOrigin: "https://relay.test", viewer: "v" };
  apply({
    relay: {
      snapshot: () => ({ scope: "https://relay.test:v", session: fake.value }),
    },
    navigation: {
      open,
      snapshot: () => ({
        entry: { target: { kind: "conversation", channelId: "alpha" } },
      }),
    },
    conversation,
    shortcuts,
  } as unknown as Parameters<typeof apply>[0]);
  expect(conversation.registerConversationSection).toHaveBeenCalledWith(
    expect.objectContaining({ id: "recent", title: "Recent" }),
  );
  const [shortcut, previous] = shortcuts.register.mock.calls.map(([s]) => s);
  expect(shortcut).toMatchObject({
    binding: { key: "d", mod: true },
    allowInEditable: true,
  });
  expect(previous).toMatchObject({
    binding: { key: "u", mod: true },
    allowInEditable: true,
  });
  expect(shortcut.when()).toBe(true);
  shortcut.run();
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "beta",
    messageId: "2",
    threadRootId: "root",
  });
  // Up from the top wraps to the bottom of the list.
  previous.run();
  expect(open).toHaveBeenLastCalledWith({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "muted",
  });
});

it("⌘D opens a DM without a message", () => {
  const fake = session([]);
  const shortcuts = { register: vi.fn() };
  const open = vi.fn(async () => ({ status: "opened" }));
  apply({
    relay: {
      snapshot: () => ({ scope: "https://relay.test:v", session: fake.value }),
    },
    navigation: {
      open,
      snapshot: () => ({
        entry: { target: { kind: "conversation", channelId: "elsewhere" } },
      }),
    },
    conversation: { registerConversationSection: vi.fn() },
    shortcuts,
  } as unknown as Parameters<typeof apply>[0]);
  shortcuts.register.mock.calls[0]?.[0].run();
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "conversation",
    scope: { communityOrigin: "https://relay.test", viewer: "v" },
    channelId: "dm",
  });
});
