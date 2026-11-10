// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession, type RelaySession } from "../relay/session";
import type { ChannelMessage, ChannelSummary } from "../relay/contracts";
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
  // The projection also asks for the roster's profiles; find the thread read.
  await vi.waitFor(() =>
    expect(
      wire.pending.some((entry) => entry.filters[0]?.ids?.[0] === root.id),
    ).toBe(true),
  );
  expect(thread.snapshot().status).toBe("loading");
  let read = wire.next();
  while (read.filters[0]?.ids?.[0] !== root.id) read = wire.next();
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
  acknowledge: (ids: readonly string[]) => h.thread.acknowledge(ids),
  authorization: (id: string) => h.thread.authorization(id),
  handoff: (messageId: string, key: string, revision: string) =>
    !!h.thread.handoff(messageId, key, revision),
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
  // Dropped from main's outbox: reported accepted — on every read, since
  // reading must not consume it — until the companion has received it.
  h.outbox.items = [];
  const terminal = {
    id: rootOp,
    messageId: ROOT,
    kind: 7 as const,
    delivery: "accepted" as const,
  };
  expect(h.thread.operations()).toEqual([terminal]);
  expect(h.thread.reactionBusy(ROOT)).toBe(false);
  expect(h.thread.snapshot().operations).toEqual([terminal]);
  // Acknowledging a non-terminal or unknown id changes nothing.
  expect(h.thread.acknowledge(["1".repeat(64)])).toBe(false);
  expect(h.thread.acknowledge([terminal.id])).toBe(true);
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
  expect(h.remove).toHaveBeenCalledWith([ROOT], undefined);
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

it("keeps terminal reports for this window ahead of the cap and until they are published", () => {
  const h = fixture();
  const idOf = (n: number) => n.toString(16).padStart(64, "0");
  const sendingOn = (n: number) => ({
    event: {
      id: idOf(n),
      pubkey: VIEWER,
      created_at: 1,
      kind: 7 as const,
      content: "👍",
      tags: [
        ["h", "channel"],
        ["e", ROOT],
      ],
    },
    delivery: "sending" as const,
  });
  // 64 unrelated channel operations and one admitted edit that main delivered.
  h.outbox.items = Array.from({ length: 64 }, (_, i) => sendingOn(100 + i));
  const edit = idOf(999);
  h.thread.admit(edit, ROOT, 40003);
  const presented = h.thread.snapshot().operations;
  expect(presented).toHaveLength(64);
  expect(presented[0]).toEqual({
    id: edit,
    messageId: ROOT,
    kind: 40003,
    delivery: "accepted",
  });
  // 65 admitted deliveries: the 65th survives a capped publication.
  h.outbox.items = [];
  for (let i = 0; i < 65; i++) h.thread.admit(idOf(2000 + i), ROOT, 7);
  const first = h.thread.snapshot().operations;
  expect(first).toHaveLength(64);
  expect(h.thread.acknowledge(first.map((op) => op.id))).toBe(true);
  const rest = h.thread.snapshot().operations;
  expect(rest.map((op) => op.id)).toEqual([idOf(2063), idOf(2064)]);
});

it("releases owner observations for agents that left the view before observing new ones", () => {
  const h = fixture();
  const disposed: string[] = [];
  const observed: string[] = [];
  (h.session as unknown as { observe: unknown }).observe = (
    filters: readonly { authors?: readonly string[] }[],
  ) => {
    const author = filters[0]?.authors?.[0] ?? "";
    observed.push(author);
    return {
      snapshot: () => ({ status: "ready", events: [] }),
      subscribe: () => () => {},
      refresh: async () => {},
      dispose: () => disposed.push(author),
    };
  };
  const verified = h.snapshot.current;
  if (!verified.root) throw new Error("root");
  const root = verified.root;
  const agentRow = (n: number): ChannelMessage => ({
    ...root,
    id: n.toString(16).padStart(64, "0"),
    authorId: (1000 + n).toString(16).padStart(64, "0"),
    agentEnvelope: true as const,
    reactions: [],
  });
  h.snapshot.current = {
    ...verified,
    replies: Array.from({ length: 32 }, (_, i) => agentRow(i)),
  };
  h.thread.snapshot();
  expect(observed).toHaveLength(32);
  // All 32 leave; one new agent arrives: the old observations release first.
  h.snapshot.current = { ...verified, replies: [agentRow(99)] };
  h.thread.snapshot();
  expect(disposed).toHaveLength(32);
  expect(observed.at(-1)).toBe((1099).toString(16).padStart(64, "0"));
  // Only the replies the window shows count: 32 older agents pushed out of
  // the 500-row window by the viewer's replies hold no slots.
  const viewerRow = (n: number): ChannelMessage => ({
    ...root,
    id: (5000 + n).toString(16).padStart(64, "0"),
    reactions: [],
  });
  h.snapshot.current = {
    ...verified,
    replies: [
      ...Array.from({ length: 32 }, (_, i) => agentRow(200 + i)),
      ...Array.from({ length: 499 }, (_, i) => viewerRow(i)),
      agentRow(300),
    ],
  };
  observed.length = 0;
  h.thread.snapshot();
  expect(observed).toEqual([(1300).toString(16).padStart(64, "0")]);
});

it("admits a verified owner's deletion in a channel that is read-only to a guest", async () => {
  const h = fixture();
  h.channel.current = {
    ...h.channel.current,
    readOnly: true,
    viewerRole: "guest",
  };
  const AGENT = "e".repeat(64);
  const verified = h.snapshot.current;
  if (!verified.root) throw new Error("root");
  h.snapshot.current = {
    ...verified,
    root: { ...verified.root, authorId: AGENT, agentEnvelope: true },
  };
  const proof = { agentId: AGENT, ownerId: VIEWER };
  const owner = createHuddleComposerOwner(
    h.session,
    "channel",
    "channel",
    undefined,
    () => true,
    () => h.thread.rootVerified(),
    undefined,
    ROOT,
    { ...shownFor(h), authorization: () => proof },
  );
  clean.push(owner.dispose);
  const client = createHuddleComposerClient(owner.token);
  clean.push(client.dispose);
  await vi.waitFor(() => expect(client.snapshot().data).toBeDefined());
  // Replies are not writable for a guest, but the owner's deletion is.
  expect(client.snapshot().data?.writable).toBe(false);
  await expect(
    client.deleteMessage({ messageId: ROOT }),
  ).resolves.toMatchObject({
    id: "removal-id",
  });
  expect(h.remove).toHaveBeenCalledWith([ROOT], proof);
  // Without proof the guest's read-only channel refuses, as main would.
  const unproven = createHuddleComposerOwner(
    h.session,
    "channel",
    "channel",
    undefined,
    () => true,
    () => h.thread.rootVerified(),
    undefined,
    ROOT,
    { ...shownFor(h), authorization: () => undefined },
  );
  clean.push(unproven.dispose);
  const other = createHuddleComposerClient(unproven.token);
  clean.push(other.dispose);
  await vi.waitFor(() => expect(other.snapshot().data).toBeDefined());
  await expect(other.deleteMessage({ messageId: ROOT })).rejects.toThrow(
    /read-only/,
  );
});

it("offers registered plugin actions as handoffs bound to their contribution, never the spawn action", async () => {
  const h = fixture();
  type Entry = import("../../plugins/contributions").Contribution<
    import("../conversation/contracts").MessageAction
  >;
  const action = (id: string, revision: string, matches = true): Entry => ({
    key: `plugin:${id}`,
    pluginId: "plugin",
    revision,
    id,
    title: id === "remind-me" ? "Remind me" : "Open thread in new window",
    matches: () => matches,
    component: () => null,
  });
  let entries: Entry[] = [
    action("remind-me", "1"),
    action("open-thread-window", "1"),
  ];
  const listeners = new Set<() => void>();
  const actions = {
    snapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const thread = createPopoutThread(
    h.session,
    "channel",
    ROOT,
    () => {},
    actions,
  );
  clean.push(thread.dispose);
  expect(thread.snapshot().root?.actions).toEqual([
    { key: "plugin:remind-me", revision: "1", title: "Remind me" },
  ]);
  expect(thread.handoff(ROOT, "plugin:remind-me", "1")?.id).toBe("remind-me");
  // The spawn action is never a handoff; a disabled/reinstalled contribution
  // (new revision) or a message it no longer matches invalidates a choice.
  expect(
    thread.handoff(ROOT, "plugin:open-thread-window", "1"),
  ).toBeUndefined();
  entries = [action("remind-me", "2")];
  for (const listener of listeners) listener();
  expect(thread.handoff(ROOT, "plugin:remind-me", "1")).toBeUndefined();
  expect(thread.handoff(ROOT, "plugin:remind-me", "2")?.id).toBe("remind-me");
  entries = [action("remind-me", "2", false)];
  expect(thread.handoff(ROOT, "plugin:remind-me", "2")).toBeUndefined();
  expect(
    thread.handoff("f".repeat(64), "plugin:remind-me", "2"),
  ).toBeUndefined();
});

it("keeps projected actions within the native bounds without rewriting identities", () => {
  const h = fixture();
  const entry = (id: string, title = id) => ({
    key: `plugin:${id}`,
    pluginId: "plugin",
    revision: "1",
    id,
    title,
    matches: () => true,
    component: () => null,
  });
  const entries = [
    entry("long", "t".repeat(257)),
    entry("wide", "é".repeat(200)), // 400 UTF-8 bytes
    ...Array.from({ length: 40 }, (_, i) => entry(`a${i}`)),
  ];
  const thread = createPopoutThread(h.session, "channel", ROOT, () => {}, {
    snapshot: () => entries,
    subscribe: () => () => {},
  });
  clean.push(thread.dispose);
  const offered = thread.snapshot().root?.actions ?? [];
  expect(offered).toHaveLength(32);
  expect(offered[0]).toEqual({ key: "plugin:a0", revision: "1", title: "a0" });
  expect(
    offered.some((a) => a.key === "plugin:long" || a.key === "plugin:wide"),
  ).toBe(false);
  // Left out of the wire projection, but still a valid handoff if asked for.
  expect(thread.handoff(ROOT, "plugin:a39", "1")?.id).toBe("a39");
});

it("projects a conversation frame from the channel window: top-level rows, no root, ready without a thread root", () => {
  const h = fixture();
  const row = (id: string, content: string) => ({
    id,
    channelId: "channel",
    authorId: VIEWER,
    createdAt: 1,
    content,
    attachments: [],
    mentions: [],
    reactions: [],
    replyCount: 0,
    participants: [],
  });
  let window = {
    channelId: "channel",
    status: "loading" as "loading" | "ready",
    rows: [] as ReturnType<typeof row>[],
    hasMore: true,
    loadingOlder: false,
    error: undefined,
  };
  const ensure = vi.fn();
  const loadOlder = vi.fn();
  const joiner = "e".repeat(64);
  const listeners = new Set<() => void>();
  const session = {
    ...h.session,
    channels: {
      ...h.session.channels,
      ensure,
      loadOlder,
      window: () => window,
      subscribeWindow: (_id: string, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    // A conversation frame never reads a thread.
    thread: () => {
      throw new Error("not a thread");
    },
  } as unknown as RelaySession;
  const changed = vi.fn();
  const frame = createPopoutThread(session, "channel", undefined, changed);
  clean.push(frame.dispose);
  expect(ensure).toHaveBeenCalledWith("channel");
  expect(frame.snapshot()).toMatchObject({
    status: "loading",
    thread: false,
    root: undefined,
    replies: [],
    writable: false,
    following: false,
  });
  window = {
    ...window,
    status: "ready",
    rows: [
      row("a".repeat(64), "First"),
      {
        ...row("b".repeat(64), ""),
        authorId: joiner,
        membership: { type: "member_joined", actor: joiner, target: joiner },
      } as never,
      { ...row("f".repeat(64), "huddle"), huddle: {} } as never,
      row("c".repeat(64), "Second"),
    ],
  };
  for (const listener of listeners) listener();
  const snap = frame.snapshot();
  expect(snap.status).toBe("ready");
  expect(snap.writable).toBe(true);
  expect(snap.canLoadMore).toBe(true);
  // A timeline keeps membership activity as notice rows (a thread frame
  // never shows them) and hides Huddle rows.
  expect(snap.replies.map((r) => r.text)).toEqual(["First", "", "Second"]);
  expect(snap.replies[1]?.membership).toEqual({
    type: "member_joined",
    actor: joiner,
    target: joiner,
  });
  expect(frame.shown("c".repeat(64))?.content).toBe("Second");
  expect(frame.rootVerified()).toBe(true);
  frame.older();
  expect(loadOlder).toHaveBeenCalledWith("channel");
  expect([...frame.known()]).toEqual([
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
  ]);
});

it("projects who is typing and which agents are working in the frame's conversation, by name", () => {
  const h = fixture();
  const typer = "1".repeat(64);
  const other = "2".repeat(64);
  const agent = "3".repeat(64);
  let entries: { channelId: string; threadRootId?: string; pubkey: string }[] =
    [];
  const listeners = new Set<() => void>();
  const session = {
    ...h.session,
    typing: {
      snapshot: () => entries,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    profiles: {
      ...h.session.profiles,
      snapshot: () =>
        new Map([
          [typer, { name: "Ada" }],
          [agent, { name: "Echo", isAgent: true }],
        ]),
    },
  } as unknown as RelaySession;
  const thread = createPopoutThread(session, "channel", ROOT, () => {});
  clean.push(thread.dispose);
  expect(thread.snapshot().typing).toBeUndefined();
  // Typing elsewhere (the channel, another thread) is not this thread's.
  entries = [
    { channelId: "channel", pubkey: typer },
    { channelId: "channel", threadRootId: "9".repeat(64), pubkey: other },
  ];
  for (const listener of listeners) listener();
  expect(thread.snapshot().typing).toBeUndefined();
  entries = [
    { channelId: "channel", threadRootId: ROOT, pubkey: typer },
    { channelId: "channel", threadRootId: ROOT, pubkey: other },
    { channelId: "channel", threadRootId: ROOT, pubkey: "4".repeat(64) },
    // An agent typing is working, not a human typing.
    { channelId: "channel", threadRootId: ROOT, pubkey: agent },
  ];
  for (const listener of listeners) listener();
  const typing = thread.snapshot().typing;
  expect(typing?.humans).toHaveLength(2);
  expect(typing?.humans[0]).toBe("Ada");
  expect(typing?.more).toBe(1);
  expect(typing?.agents).toEqual(["Echo"]);
});

it("a conversation frame's owner admits sends and message actions against its shown rows without a roster", async () => {
  const h = fixture();
  const row = {
    id: "a".repeat(64),
    channelId: "channel",
    authorId: VIEWER,
    createdAt: 1,
    content: "First",
    attachments: [],
    mentions: [],
    reactions: [],
    replyCount: 0,
    participants: [],
  };
  const send = vi.fn(() => "sent-id");
  const session = {
    ...h.session,
    channels: {
      ...h.session.channels,
      // A ready, writable channel whose summary carries no members.
      get: () => ({ id: "channel", name: "Channel", channelType: "stream" }),
      ensure: () => {},
      loadOlder: () => {},
      window: () => ({
        channelId: "channel",
        status: "ready",
        rows: [row],
        hasMore: false,
        loadingOlder: false,
        error: undefined,
      }),
      subscribeWindow: () => () => {},
    },
    messages: { ...h.session.messages, send },
  } as unknown as RelaySession;
  const frame = createPopoutThread(session, "channel", undefined, () => {});
  clean.push(frame.dispose);
  expect(frame.writable()).toBe(true);
  const owner = createHuddleComposerOwner(
    session,
    "channel",
    "channel",
    undefined,
    () => true,
    () => frame.rootVerified(),
    undefined,
    undefined,
    {
      message: (id) => frame.shown(id),
      reactionBusy: (id) => frame.reactionBusy(id),
      retryOperation: (id) => frame.retryOperation(id),
      version: () => frame.snapshot().version,
      root: () => undefined,
      admit: (id, messageId, kind) => frame.admit(id, messageId, kind),
      acknowledge: (ids) => frame.acknowledge(ids),
      authorization: (id) => frame.authorization(id),
      handoff: (messageId, key, revision) =>
        !!frame.handoff(messageId, key, revision),
    },
  );
  clean.push(owner.dispose);
  const client = createHuddleComposerClient(owner.token);
  clean.push(client.dispose);
  await vi.waitFor(() => expect(client.snapshot().data?.writable).toBe(true));
  const composer = client.snapshot().session;
  if (!composer) throw new Error("composer session");
  await expect(composer.messages.send("channel", "hello")).resolves.toBe(
    "sent-id",
  );
  expect(send).toHaveBeenCalled();
  await expect(
    client.react({ messageId: row.id, content: "🎉" }),
  ).resolves.toMatchObject({ id: "reaction-id" });
  await expect(
    client.markRead({ messageId: row.id, unread: true }),
  ).resolves.toBeUndefined();
  expect(h.markMessageUnread).toHaveBeenCalledWith("channel", row.id);
  // Thread-only operations stay refused for a conversation frame.
  await expect(client.follow({ following: true })).rejects.toThrow(
    /Not a thread/,
  );
  await expect(client.sendToChannel({ messageId: row.id })).rejects.toThrow(
    /thread replies/,
  );
});

it("classifies typing as main's indicator does: thread work at a shown root is the thread's, and an agent live activity identifies is never a human typer", () => {
  const h = fixture();
  const agent = "3".repeat(64);
  const root = {
    ...(h.snapshot.current.root as ChannelMessage),
    replyCount: 2,
  };
  const activity = {
    ...h.session.agentActivity.snapshot(),
    local: [
      {
        scope: h.session.scope,
        agent,
        channelId: "channel",
        messageId: ROOT,
        threadRootId: ROOT,
        // No thread hint: the conversation frame must infer it from the shown
        // root's replies, as main's indicator does.
        state: "working" as const,
        startedAt: Date.now(),
      },
    ],
  };
  // Echo also sends typing into the thread, and its profile does not yet say
  // it is an agent.
  const entries = [{ channelId: "channel", threadRootId: ROOT, pubkey: agent }];
  const session = {
    ...h.session,
    channels: {
      ...h.session.channels,
      ensure() {},
      refresh() {},
      window: () => ({
        channelId: "channel",
        status: "ready" as const,
        rows: [root],
        loadingOlder: false,
        hasMore: false,
        error: undefined,
      }),
      subscribeWindow: () => () => {},
    },
    typing: { ...h.session.typing, snapshot: () => entries },
    profiles: {
      ...h.session.profiles,
      snapshot: () => new Map([[agent, { name: "Echo" }]]),
    },
    agentActivity: { ...h.session.agentActivity, snapshot: () => activity },
  } as unknown as RelaySession;
  const conversation = createPopoutThread(
    session,
    "channel",
    undefined,
    () => {},
  );
  const thread = createPopoutThread(session, "channel", ROOT, () => {});
  clean.push(conversation.dispose, thread.dispose);
  expect(thread.snapshot().typing).toEqual({
    humans: [],
    more: 0,
    agents: ["Echo"],
  });
  // The conversation frame shows that root with replies: the work belongs to
  // its thread, not the channel's status line.
  expect(conversation.snapshot().typing).toBeUndefined();
});

it("labels bare message links as main's byline does, through the shared author lookups, and releases lookups that leave the view", async () => {
  const h = fixture();
  const AUTHOR = "f".repeat(64);
  const LINKED = "9".repeat(64);
  const OTHER = "8".repeat(64);
  const url = `buzz://message?channel=design&id=${LINKED}`;
  const other = `buzz://message?channel=design&id=${OTHER}`;
  let generation = 0;
  // The linked channel is listed and confirmed; "dm" or Solo would keep the
  // existing presentation, so neither is named.
  const design: ChannelSummary = {
    id: "design",
    name: "design",
    channelType: "stream",
    members: [AUTHOR, VIEWER],
  };
  const solo: ChannelSummary = {
    id: "solo",
    name: "Solo",
    channelType: "solo",
  };
  const linked = (id: string, channelId: string): ChannelMessage => ({
    id,
    channelId,
    authorId: AUTHOR,
    createdAt: 1,
    content: "Linked",
    attachments: [],
    mentions: [],
    reactions: [],
    replyCount: 0,
    participants: [],
  });
  // Exact reads main's links would run: resolve the first on demand, hold
  // the second to prove a released lookup never labels.
  const reads = new Map<
    string,
    { settle(row?: ChannelMessage): void; disposed: boolean }
  >();
  const session = {
    ...h.session,
    names: {
      resolve: (pubkey: string, fallback: string) =>
        pubkey === AUTHOR ? "Ada" : fallback,
      subscribe: () => () => {},
      snapshot: () => 0,
    },
    profiles: {
      ...h.session.profiles,
      ensure: vi.fn(async () => {}),
      generation: () => generation,
      evictions: () => 0,
    },
    channels: {
      ...h.session.channels,
      list: () => ({ ...h.session.channels.list(), channels: [design, solo] }),
      window: () => ({
        channelId: "design",
        status: "ready",
        rows: [],
        hasMore: false,
        loadingOlder: false,
        error: undefined,
        freshness: "cached",
      }),
    },
    thread: (channelId: string, id: string, options?: { exact?: boolean }) => {
      if (id === ROOT && !options?.exact)
        return h.session.thread(channelId, id);
      let snapshot: ThreadSnapshot = {
        status: "loading",
        error: undefined,
        canLoadMore: false,
        limited: false,
        root: undefined,
        replies: [],
      };
      const listeners = new Set<() => void>();
      const entry = {
        disposed: false,
        settle(row?: ChannelMessage) {
          snapshot = row
            ? {
                ...snapshot,
                status: "ready",
                target: row,
                targetStatus: "ready",
              }
            : { ...snapshot, status: "error", error: "gone" };
          for (const listener of listeners) listener();
        },
      };
      reads.set(id, entry);
      return {
        snapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        refresh: async () => {},
        loadMore: async () => {},
        retarget: async () => "selected" as const,
        dispose: () => {
          entry.disposed = true;
        },
      };
    },
  } as unknown as RelaySession;
  const root = () => {
    const current = h.snapshot.current.root;
    if (!current) throw new Error("fixture root");
    return current;
  };
  const settle = (id: string, row: ChannelMessage) => {
    const read = reads.get(id);
    if (!read) throw new Error(`no read for ${id}`);
    read.settle(row);
  };
  const changed = vi.fn();
  const thread = createPopoutThread(session, "channel", ROOT, changed);
  clean.push(() => thread.dispose());
  h.snapshot.current = {
    ...h.snapshot.current,
    root: {
      ...root(),
      content: `See ${url} and [the other](${other}) and buzz://message?channel=solo&id=${OTHER}`,
    },
  };

  // Projecting the rows starts a lookup only for the bare link in a named
  // channel; the labelled link keeps its label and the Solo link its chip.
  expect(thread.snapshot().root?.linkLabels).toBeUndefined();
  // Lookups start after the commit that mounted them, as for links.
  await vi.waitFor(() => expect([...reads.keys()]).toEqual([LINKED]));
  settle(LINKED, linked(LINKED, "design"));
  expect(changed).toHaveBeenCalled();
  expect(thread.snapshot().root?.linkLabels).toEqual({
    [url]: "Ada in #design",
  });
  // A found author is kept for the session, as main's links keep it.
  expect(session.profiles.ensure).toHaveBeenCalledWith([AUTHOR], "background");

  // A link that leaves the shown rows releases its lookup before a new one
  // is held; a message link to no one yet named stays unlabelled.
  h.snapshot.current = {
    ...h.snapshot.current,
    root: { ...root(), content: `Now ${other}` },
  };
  expect(thread.snapshot().root?.linkLabels).toBeUndefined();
  await vi.waitFor(() => expect([...reads.keys()]).toEqual([LINKED, OTHER]));
  // Gone before its author arrived: the pending read is cancelled with it.
  h.snapshot.current = {
    ...h.snapshot.current,
    root: { ...root(), content: "No links" },
  };
  expect(thread.snapshot().root?.linkLabels).toBeUndefined();
  expect(reads.get(OTHER)?.disposed).toBe(true);
  // Shown again: a new lookup; the found author needs none.
  h.snapshot.current = {
    ...h.snapshot.current,
    root: { ...root(), content: `Both ${url} ${other}` },
  };
  expect(thread.snapshot().root?.linkLabels).toEqual({
    [url]: "Ada in #design",
  });
  reads.delete(OTHER);
  await vi.waitFor(() => expect(reads.has(OTHER)).toBe(true));
  settle(OTHER, linked(OTHER, "design"));
  expect(thread.snapshot().root?.linkLabels).toEqual({
    [url]: "Ada in #design",
    [other]: "Ada in #design",
  });

  // The renderer's eligibility, not the raw text: `[url](url)` and `<url>`
  // read as bare links and take the byline; a URL in code never starts a
  // read, nor holds a slot. Markdown the body shows as plain text has none.
  const CODED = "7".repeat(64);
  const coded = `buzz://message?channel=design&id=${CODED}`;
  h.snapshot.current = {
    ...h.snapshot.current,
    root: {
      ...root(),
      content: `[${url}](${url}) <${other}> \`${coded}\`\n\n\`\`\`\n${coded}\n\`\`\``,
    },
  };
  expect(thread.snapshot().root?.linkLabels).toEqual({
    [url]: "Ada in #design",
    [other]: "Ada in #design",
  });
  await Promise.resolve();
  expect(reads.has(CODED)).toBe(false);

  // Profiles follow the directory's invalidation contract: ensured once per
  // author while shown, again after a cache clear.
  // (Once when first labelled; once more when its links returned after
  // "No links" dropped the author from the shown set.)
  const ensured = vi.mocked(session.profiles.ensure).mock.calls.length;
  thread.snapshot();
  expect(session.profiles.ensure).toHaveBeenCalledTimes(ensured);
  generation = 1;
  thread.snapshot();
  expect(session.profiles.ensure).toHaveBeenCalledTimes(ensured + 1);
  expect(session.profiles.ensure).toHaveBeenLastCalledWith(
    [AUTHOR],
    "background",
  );
  thread.snapshot();
  expect(session.profiles.ensure).toHaveBeenCalledTimes(ensured + 1);
});

it("projects the conversation's kind, names a DM by its people and carries their picture, as the tab strip does", () => {
  const h = fixture();
  const ADA = "f".repeat(64);
  const BOB = "e".repeat(64);
  const profiles = new Map([
    [ADA, { name: "Ada", picture: "https://relay.example/ada.png" }],
    [BOB, { name: "Bob" }],
  ]);
  const session = {
    ...h.session,
    profiles: { ...h.session.profiles, snapshot: () => profiles },
    media: (url: string) =>
      `http://buzz-media.localhost/${encodeURIComponent(url)}`,
  } as unknown as RelaySession;
  const thread = createPopoutThread(session, "channel", ROOT, () => {});
  clean.push(() => thread.dispose());
  const shape = () => {
    const { title, kind, picture, isDm } = thread.snapshot();
    return { title, kind, picture, isDm };
  };
  expect(shape()).toEqual({
    title: "Channel",
    kind: "channel",
    picture: null,
    isDm: false,
  });
  h.channel.current = { ...h.channel.current, private: true };
  expect(shape()).toMatchObject({ kind: "private", picture: null });
  h.channel.current = {
    id: "channel",
    name: "Planning",
    channelType: "solo",
  };
  expect(shape()).toEqual({
    title: "Planning",
    kind: "solo",
    picture: null,
    isDm: true,
  });
  // A DM is named by its people, not the relay's channel name, and shows
  // the first person's picture through the authorized media source.
  h.channel.current = {
    id: "channel",
    name: "dm-internal",
    channelType: "dm",
    participants: [ADA, BOB],
  };
  expect(shape()).toEqual({
    title: "Ada, Bob",
    kind: "dm",
    picture: `http://buzz-media.localhost/${encodeURIComponent("https://relay.example/ada.png")}`,
    isDm: true,
  });
});

it("projects members as main's header previews them: people (or agents, for Solo) with pictures first, the whole count, and one profile request", () => {
  const h = fixture();
  const ADA = "f".repeat(64);
  const BOB = "e".repeat(64);
  const CAT = "d".repeat(64);
  const AGENT = "c".repeat(64);
  const profiles = new Map([
    [ADA, { name: "Ada" }],
    [BOB, { name: "Bob", picture: "https://relay.example/bob.png" }],
    [AGENT, { name: "Echo", isAgent: true as const }],
  ]);
  const ensure = vi.fn(async () => {});
  const session = {
    ...h.session,
    profiles: { ...h.session.profiles, snapshot: () => profiles, ensure },
    media: (url: string) => `media:${url}`,
  } as unknown as RelaySession;
  const thread = createPopoutThread(session, "channel", ROOT, () => {});
  clean.push(() => thread.dispose());
  expect(thread.snapshot().members).toBeUndefined();
  h.channel.current = {
    ...h.channel.current,
    members: [VIEWER, ADA, BOB, CAT, AGENT],
  };
  expect(thread.snapshot().members).toEqual({
    count: 4,
    solo: false,
    preview: [
      { id: BOB, name: "Bob", picture: "media:https://relay.example/bob.png" },
      { id: VIEWER, name: expect.any(String), picture: null },
      { id: ADA, name: "Ada", picture: null },
    ],
  });
  thread.snapshot();
  // The whole roster (bounded) is enriched before filtering, as main's
  // header does: a fourth member's late profile can change the preview.
  expect(ensure).toHaveBeenCalledExactlyOnceWith(
    [VIEWER, ADA, BOB, CAT, AGENT],
    "background",
  );
  profiles.set(CAT, { name: "Cat", isAgent: true as const });
  expect(thread.snapshot().members?.count).toBe(3);
  // A Solo chat previews its agents.
  h.channel.current = {
    id: "channel",
    name: "Planning",
    channelType: "solo",
    members: [VIEWER, AGENT],
  };
  expect(thread.snapshot().members).toEqual({
    count: 1,
    solo: true,
    preview: [{ id: AGENT, name: "Echo", picture: null }],
  });
});
