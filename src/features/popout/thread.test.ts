// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession, type RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { ThreadSnapshot } from "../relay/threads";
import { createHuddleComposerOwner } from "../huddle/composer-owner";
import { createHuddleComposerClient } from "../huddle/composer-client";
import { createPopoutThread } from "./thread";
import type { LiveCallbacks } from "../relay/live";
import { keypair, message, roster, scriptedTransport } from "../relay/testing";

const clean: (() => void)[] = [];
afterEach(() => {
  for (const dispose of clean.splice(0)) dispose();
});
const ROOT = "b".repeat(64);
const VIEWER = "a".repeat(64);

it("loads a seeded session thread on opening before offering replies", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const store = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  clean.push(store.dispose);
  const root = message(viewer, "channel", "Root", 1);
  live.receive([roster(relay, "channel", [viewer.pubkey]), root]);
  const changed = vi.fn();
  const thread = createPopoutThread(store.session, "channel", root.id, changed);
  clean.push(thread.dispose);

  // Seeded rows alone are not a completed thread read. Hold the actual relay
  // request to prove the reply gate stays closed until its verified fold.
  expect(thread.snapshot().root?.id).toBe(root.id);
  expect(thread.writable()).toBe(false);
  await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
  expect(thread.snapshot().status).toBe("loading");
  const read = wire.next();
  expect(read.filters[0]?.ids).toEqual([root.id]);
  expect(read.filters[0]?.["#h"]).toEqual(["channel"]);
  read.respond([root]);
  await vi.waitFor(() => expect(thread.snapshot().status).toBe("ready"));
  expect(thread.rootVerified()).toBe(true);
  expect(thread.writable()).toBe(true);
  expect(changed).toHaveBeenCalled();
});

/** A verified thread root in a stream whose summary carries no roster: the
 * common shape of a channel summary ("absent means unknown"). */
function fixture() {
  const store = createRelaySession(null);
  clean.push(() => store.dispose());
  const channel: { current: ChannelSummary } = {
    current: { id: "channel", name: "Channel", channelType: "stream" },
  };
  const snapshot: { current: ThreadSnapshot } = {
    current: {
      status: "ready",
      error: undefined,
      canLoadMore: false,
      limited: false,
      root: {
        id: ROOT,
        channelId: "channel",
        authorId: VIEWER,
        createdAt: 1,
        content: "Root",
        attachments: [],
        mentions: [],
        reactions: [
          {
            content: "👍",
            events: [
              { id: "c".repeat(64), authorId: VIEWER },
              { id: "d".repeat(64), authorId: "e".repeat(64) },
            ],
          },
        ],
        replyCount: 0,
        participants: [],
      },
      replies: [],
    },
  };
  const reply = vi.fn(() => "accepted-id");
  const react = vi.fn(() => "reaction-id");
  const remove = vi.fn(() => "removal-id");
  const outbox: { items: import("../relay/outbox").OutgoingEvent[] } = {
    items: [],
  };
  const retry = vi.fn();
  const session = {
    ...store.session,
    viewer: VIEWER,
    scope: `https://example.test:${VIEWER}`,
    channels: { ...store.session.channels, get: () => channel.current },
    thread: () => ({
      snapshot: () => snapshot.current,
      subscribe: () => () => {},
      refresh: async () => {},
      loadMore: async () => {},
      retarget: async () => "selected" as const,
      dispose: () => {},
    }),
    messages: { ...store.session.messages, reply, react, remove },
    outbox: {
      snapshot: () => outbox.items,
      subscribe: () => () => {},
      retry,
      supports: () => true,
    },
  } as unknown as RelaySession;
  const thread = createPopoutThread(session, "channel", ROOT, () => {});
  clean.push(() => thread.dispose());
  return {
    session,
    channel,
    snapshot,
    thread,
    reply,
    react,
    remove,
    outbox,
    retry,
  };
}
const OWN_EVENT = "c".repeat(64);
const OTHER_EVENT = "d".repeat(64);

it("offers and admits replies in a verified thread whose summary has no roster", async () => {
  const h = fixture();
  expect(h.thread.rootVerified()).toBe(true);
  expect(h.thread.writable()).toBe(true);
  const owner = createHuddleComposerOwner(
    h.session,
    "channel",
    "channel",
    undefined,
    () => true,
    () => h.thread.rootVerified(),
    undefined,
    ROOT,
  );
  clean.push(owner.dispose);
  const client = createHuddleComposerClient(owner.token);
  clean.push(client.dispose);
  await vi.waitFor(() => expect(client.snapshot().data?.writable).toBe(true));
  const session = client.snapshot().session;
  if (!session) throw new Error("composer session");
  await expect(session.messages.reply("channel", ROOT, "hello")).resolves.toBe(
    "accepted-id",
  );
  expect(h.reply).toHaveBeenCalledWith(
    "channel",
    ROOT,
    "hello",
    [],
    [],
    ROOT,
    [],
    {},
  );
});

it("keeps the root, read-only, cached and archived gates", () => {
  const h = fixture();
  for (const flag of ["readOnly", "cached", "archived"] as const) {
    h.channel.current = { ...h.channel.current, [flag]: true };
    expect(h.thread.writable(), flag).toBe(false);
    h.channel.current = {
      id: "channel",
      name: "Channel",
      channelType: "stream",
    };
  }
  expect(h.thread.writable()).toBe(true);
  // An absent, wrong or still-loading root offers no reply box.
  const verified = h.snapshot.current;
  h.snapshot.current = { ...verified, root: undefined };
  expect(h.thread.rootVerified()).toBe(false);
  expect(h.thread.writable()).toBe(false);
  h.snapshot.current = {
    ...verified,
    root: verified.root && { ...verified.root, id: "c".repeat(64) },
  };
  expect(h.thread.writable()).toBe(false);
  h.snapshot.current = { ...verified, status: "loading" };
  expect(h.thread.writable()).toBe(false);
});

it("admits reactions only for shown messages and removes only the viewer's own", async () => {
  const h = fixture();
  const owner = createHuddleComposerOwner(
    h.session,
    "channel",
    "channel",
    undefined,
    () => true,
    () => h.thread.rootVerified(),
    undefined,
    ROOT,
    {
      message: (id) => h.thread.shown(id),
      reactionBusy: (id) => h.thread.reactionBusy(id),
      retryReaction: (id) => h.thread.retryReaction(id),
    },
  );
  clean.push(owner.dispose);
  const client = createHuddleComposerClient(owner.token);
  clean.push(client.dispose);
  await vi.waitFor(() => expect(client.snapshot().data?.writable).toBe(true));
  await expect(client.react({ messageId: ROOT, content: "🎉" })).resolves.toBe(
    "reaction-id",
  );
  expect(h.react).toHaveBeenCalledWith(ROOT, "🎉", undefined);
  await expect(
    client.react({ messageId: "f".repeat(64), content: "🎉" }),
  ).rejects.toThrow(/not shown in this window/);
  await expect(
    client.react({ messageId: ROOT, content: "x".repeat(600) }),
  ).rejects.toThrow(/Invalid reaction/);
  await expect(
    client.removeReactions({ messageId: ROOT, ids: [OWN_EVENT] }),
  ).resolves.toBeUndefined();
  expect(h.remove).toHaveBeenCalledWith([OWN_EVENT]);
  await expect(
    client.removeReactions({ messageId: ROOT, ids: [OTHER_EVENT] }),
  ).rejects.toThrow(/Only your own reactions/);
  // The root's own reactions are projected with the viewer's event first.
  expect(h.thread.snapshot().root?.reactions?.[0]?.events[0]?.authorId).toBe(
    VIEWER,
  );
  // A loading root blocks reactions as it blocks replies.
  h.snapshot.current = { ...h.snapshot.current, status: "loading" };
  await expect(
    client.react({ messageId: ROOT, content: "🎉" }),
  ).rejects.toThrow();
});

it("fences reactions while main still has one in flight, and retries only main's own events", async () => {
  const h = fixture();
  const owner = createHuddleComposerOwner(
    h.session,
    "channel",
    "channel",
    undefined,
    () => true,
    () => h.thread.rootVerified(),
    undefined,
    ROOT,
    {
      message: (id) => h.thread.shown(id),
      reactionBusy: (id) => h.thread.reactionBusy(id),
      retryReaction: (id) => h.thread.retryReaction(id),
    },
  );
  clean.push(owner.dispose);
  const client = createHuddleComposerClient(owner.token);
  clean.push(client.dispose);
  await vi.waitFor(() => expect(client.snapshot().data?.writable).toBe(true));
  const sending = "9".repeat(64);
  h.outbox.items = [
    {
      event: {
        id: sending,
        pubkey: VIEWER,
        created_at: 1,
        kind: 7,
        content: "👍",
        tags: [
          ["h", "channel"],
          ["e", ROOT],
        ],
      },
      delivery: "sending",
    },
  ];
  // Projected for the companion, and blocking another change meanwhile.
  expect(h.thread.snapshot().reactionOperations).toEqual([
    { id: sending, messageId: ROOT, kind: 7, delivery: "sending" },
  ]);
  await expect(
    client.react({ messageId: ROOT, content: "🎉" }),
  ).rejects.toThrow(/still being sent/);
  expect(h.react).not.toHaveBeenCalled();
  // Retry is admitted only for main's own reaction event on a shown message.
  await expect(client.retryReaction({ id: sending })).resolves.toBeUndefined();
  expect(h.retry).toHaveBeenCalledWith(sending, expect.any(Function));
  await expect(client.retryReaction({ id: "8".repeat(64) })).rejects.toThrow(
    /no longer be retried/,
  );
  h.outbox.items = [];
  await expect(client.react({ messageId: ROOT, content: "🎉" })).resolves.toBe(
    "reaction-id",
  );
});

it("fences and retries from the whole operation collection, capping only the presentation", async () => {
  const h = fixture();
  const sendingOn = (messageId: string, n: number) => ({
    event: {
      id: n.toString(16).padStart(64, "0"),
      pubkey: VIEWER,
      created_at: 1,
      kind: 7 as const,
      content: "👍",
      tags: [
        ["h", "channel"],
        ["e", messageId],
      ],
    },
    delivery: "sending" as const,
  });
  // 64 replies, each with a sending reaction, then the root's as the 65th.
  const replies = Array.from({ length: 64 }, (_, i) => ({
    ...fixture().snapshot.current.root,
    id: (i + 1).toString(16).padStart(64, "a"),
    reactions: [],
  }));
  h.snapshot.current = {
    ...h.snapshot.current,
    replies: replies as typeof h.snapshot.current.replies,
  };
  h.outbox.items = [
    ...replies.map((reply, i) => sendingOn(reply.id, 100 + i)),
    sendingOn(ROOT, 999),
  ];
  expect(h.thread.snapshot().reactionOperations).toHaveLength(64);
  expect(h.thread.reactionOperations()).toHaveLength(65);
  expect(h.thread.reactionBusy(ROOT)).toBe(true);
  expect(h.thread.retryReaction((999).toString(16).padStart(64, "0"))).toBe(
    true,
  );
});
