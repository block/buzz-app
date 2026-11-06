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
  const edit = vi.fn(() => "edit-id");
  const sendToChannel = vi.fn(() => "copy-id");
  const report = vi.fn(async () => {});
  const markMessageRead = vi.fn(async () => ({}));
  const markMessageUnread = vi.fn(async () => ({}));
  const follow = vi.fn();
  let following = false;
  let unread = false;
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
    messages: {
      ...store.session.messages,
      reply,
      react,
      remove,
      edit,
      sendToChannel,
      report,
    },
    unread: {
      ...store.session.unread,
      attention: () => ({ unread, forced: false }),
      following: () => following,
      follow: (c: string, r: string, v: boolean) => {
        follow(c, r, v);
        following = v;
      },
      markMessageRead,
      markMessageUnread,
      subscribe: () => () => {},
    },
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
    edit,
    sendToChannel,
    report,
    markMessageRead,
    markMessageUnread,
    follow,
    outbox,
    retry,
    setUnread: (value: boolean) => {
      unread = value;
    },
  };
}
const shownFor = (h: ReturnType<typeof fixture>) => ({
  message: (id: string) => h.thread.shown(id),
  reactionBusy: (id: string) => h.thread.reactionBusy(id),
  retryOperation: (id: string) => h.thread.retryOperation(id),
  version: () => h.thread.snapshot().version,
  root: () => h.thread.shown(ROOT),
  admit: (id: string, messageId: string | undefined, kind: 7 | 5 | 40003 | 9) =>
    h.thread.admit(id, messageId, kind),
});
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
    shownFor(h),
  );
  clean.push(owner.dispose);
  const client = createHuddleComposerClient(owner.token);
  clean.push(client.dispose);
  await vi.waitFor(() => expect(client.snapshot().data?.writable).toBe(true));
  await expect(
    client.react({ messageId: ROOT, content: "🎉" }),
  ).resolves.toMatchObject({ id: "reaction-id" });
  expect(h.react).toHaveBeenCalledWith(ROOT, "🎉", undefined);
  await expect(
    client.react({ messageId: "f".repeat(64), content: "🎉" }),
  ).rejects.toThrow(/not shown in this window/);
  await expect(
    client.react({ messageId: ROOT, content: "x".repeat(600) }),
  ).rejects.toThrow(/Invalid reaction/);
  await expect(
    client.removeReactions({ messageId: ROOT, ids: [OWN_EVENT] }),
  ).resolves.toMatchObject({ id: "removal-id" });
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
    shownFor(h),
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
  expect(h.thread.snapshot().operations).toEqual([
    { id: sending, messageId: ROOT, kind: 7, delivery: "sending" },
  ]);
  await expect(
    client.react({ messageId: ROOT, content: "🎉" }),
  ).rejects.toThrow(/still being sent/);
  expect(h.react).not.toHaveBeenCalled();
  // Retry is admitted only for operations main admitted for this window —
  // not for every operation in the channel, however shown its target is.
  await expect(client.retryOperation({ id: sending })).rejects.toThrow(
    /no longer be retried/,
  );
  h.thread.admit(sending, ROOT, 7);
  await expect(client.retryOperation({ id: sending })).resolves.toBeUndefined();
  expect(h.retry).toHaveBeenCalledWith(sending, expect.any(Function));
  await expect(client.retryOperation({ id: "8".repeat(64) })).rejects.toThrow(
    /no longer be retried/,
  );
  h.outbox.items = [];
  await expect(
    client.react({ messageId: ROOT, content: "🎉" }),
  ).resolves.toMatchObject({ id: "reaction-id" });
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
  expect(h.thread.snapshot().operations).toHaveLength(64);
  expect(h.thread.operations()).toHaveLength(65);
  expect(h.thread.reactionBusy(ROOT)).toBe(true);
  const rootOp = (999).toString(16).padStart(64, "0");
  expect(h.thread.retryOperation(rootOp)).toBe(false);
  h.thread.admit(rootOp, ROOT, 7);
  expect(h.thread.retryOperation(rootOp)).toBe(true);
  // This window's admitted operations lead the capped presentation.
  expect(h.thread.snapshot().operations[0]?.id).toBe(rootOp);
  // Dropped from main's outbox: reported delivered once, then forgotten.
  h.outbox.items = [];
  expect(h.thread.operations()).toEqual([
    { id: rootOp, messageId: ROOT, kind: 7, delivery: "accepted" },
  ]);
  expect(h.thread.operations()).toEqual([]);
  // A message deletion names its message, unlike a reaction removal.
  h.outbox.items = [
    {
      event: {
        id: "7".repeat(64),
        pubkey: VIEWER,
        created_at: 1,
        kind: 5,
        content: "",
        tags: [
          ["h", "channel"],
          ["e", ROOT],
          ["k", "9"],
        ],
      },
      delivery: "failed",
      error: "Relay refused",
    },
  ];
  expect(h.thread.operations()[0]).toMatchObject({ messageId: ROOT, kind: 5 });
});

it("projects main's own management policy per row and admits each action by the same rules", async () => {
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
    shownFor(h),
  );
  clean.push(owner.dispose);
  const client = createHuddleComposerClient(owner.token);
  clean.push(client.dispose);
  await vi.waitFor(() => expect(client.snapshot().data?.writable).toBe(true));
  // The root is the viewer's own delivered message in a writable stream.
  const root = h.thread.snapshot().root;
  expect(root?.management).toEqual({
    unread: false,
    canEdit: true,
    canDelete: true,
    canSendToChannel: false,
    canReport: true,
  });
  expect(root?.editable).toEqual({
    sourceContent: "Root",
    attachmentSourceId: ROOT,
  });
  expect(h.thread.snapshot().following).toBe(false);
  // Delete: own only.
  await expect(
    client.deleteMessage({ messageId: ROOT }),
  ).resolves.toMatchObject({
    id: "removal-id",
  });
  expect(h.remove).toHaveBeenCalledWith([ROOT]);
  const verified = h.snapshot.current;
  if (!verified.root) throw new Error("root");
  const theirs = { ...verified.root, authorId: "e".repeat(64) };
  h.snapshot.current = { ...verified, root: theirs };
  await expect(client.deleteMessage({ messageId: ROOT })).rejects.toThrow(
    /Only your own messages can be deleted/,
  );
  expect(h.thread.snapshot().root?.management?.canDelete).toBe(false);
  expect(h.thread.snapshot().root?.editable).toBeUndefined();
  h.snapshot.current = verified;
  // Edit: exact baseline, or main refuses rather than overwrite an unseen change.
  await expect(
    client.edit({
      messageId: ROOT,
      content: "Root!",
      attachmentSourceId: ROOT,
      baseline: "Root",
    }),
  ).resolves.toMatchObject({ id: "edit-id" });
  expect(h.edit).toHaveBeenCalledWith(ROOT, "Root!", ROOT);
  await expect(
    client.edit({
      messageId: ROOT,
      content: "Root!",
      attachmentSourceId: ROOT,
      baseline: "older",
    }),
  ).rejects.toThrow(/changed while you were editing/);
  // Send to channel: only own thread replies.
  await expect(client.sendToChannel({ messageId: ROOT })).rejects.toThrow(
    /thread replies/,
  );
  const reply = { ...verified.root, id: "d".repeat(64), threadRootId: ROOT };
  h.snapshot.current = { ...verified, replies: [reply] };
  expect(h.thread.snapshot().replies[0]?.management?.canSendToChannel).toBe(
    true,
  );
  await expect(
    client.sendToChannel({ messageId: reply.id }),
  ).resolves.toMatchObject({
    id: "copy-id",
  });
  expect(h.sendToChannel).toHaveBeenCalledWith(reply, verified.root);
  // Read state and follow go through main's owners.
  await client.markRead({ messageId: ROOT, unread: true });
  expect(h.markMessageUnread).toHaveBeenCalledWith("channel", ROOT);
  h.setUnread(true);
  expect(h.thread.snapshot().root?.management?.unread).toBe(true);
  await client.markRead({ messageId: ROOT, unread: false });
  expect(h.markMessageRead).toHaveBeenCalledWith("channel", ROOT);
  await client.follow({ following: true });
  expect(h.follow).toHaveBeenCalledWith("channel", ROOT, true);
  expect(h.thread.snapshot().following).toBe(true);
  await client.report({ messageId: ROOT, type: "spam", note: "x" });
  expect(h.report).toHaveBeenCalledWith(ROOT, "spam", "x");
  await expect(
    client.report({ messageId: "f".repeat(64), type: "spam", note: "" }),
  ).rejects.toThrow(/not shown/);
});
