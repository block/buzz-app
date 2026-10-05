import { verifiedSymbol } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelQueries } from "./contracts";
import type { RelayEvent } from "./events";
import { createReadState } from "./read-state";
import { readJournal, type ReadJournal } from "./read-state-storage";
import {
  memoryThreadFollows,
  type ThreadFollowStorage,
} from "./thread-follows";
import { createUnread } from "./unread";

// Explicit follow choices against the real unread engine. Events are marked
// verified, as the transport delivers them; signatures are not under test.
let next = 0;
function event(
  pubkey: string,
  created_at: number,
  tags: string[][],
  channel = "c0",
): RelayEvent {
  return {
    id: (next++).toString(16).padStart(64, "0"),
    pubkey,
    kind: 9,
    created_at,
    content: "",
    tags: [["h", channel], ...tags],
    sig: "0".repeat(128),
    [verifiedSymbol]: true,
  };
}
const reply = (
  pubkey: string,
  time: number,
  root: RelayEvent,
  parent = root,
  extra: string[][] = [],
) =>
  event(
    pubkey,
    time,
    [["e", root.id, "", "root"], ["e", parent.id, "", "reply"], ...extra],
    root.tags[0]?.[1],
  );
const viewer = "a".repeat(64),
  peer = "b".repeat(64);

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

async function setup(follows: ThreadFollowStorage = memoryThreadFollows()) {
  let journal: ReadJournal | undefined;
  // Nothing beyond the retained window: every parent lookup answers "not yours".
  const reader = { read: vi.fn(async () => []) };
  const reads = createReadState({
    viewer,
    reader,
    host: undefined,
    storage: {
      async update(change) {
        journal = readJournal(change(journal), viewer);
        return journal;
      },
      close() {},
    },
  });
  await reads.ready;
  const channels: ChannelQueries = {
    list: () => ({
      status: "ready" as const,
      channels: [
        { id: "c0", name: "Zero", members: [viewer] },
        { id: "c1", name: "One", members: [viewer] },
        { id: "dm", name: "Peer", members: [viewer, peer], channelType: "dm" },
      ],
    }),
    subscribeList: () => () => {},
    window() {
      throw new Error("Unread must not inspect windows");
    },
    subscribeWindow() {
      throw new Error("Unread must not subscribe to windows");
    },
    ensureList() {},
    ensure() {},
    loadOlder() {},
  };
  const owner = createUnread({ reads, channels, reader, viewer, follows });
  owners.push(owner);
  const unread = owner.capability;
  /** Settles the parent lookups that undecided replies queue. */
  const settled = async (...replies: RelayEvent[]) => {
    for (const item of replies)
      unread.attention(item.tags[0]?.[1] ?? "", item.id);
    await vi.waitFor(() => {
      for (const item of replies)
        expect(
          unread.attention(item.tags[0]?.[1] ?? "", item.id).pending,
        ).toBeUndefined();
    });
  };
  return { owner, unread, reader, settled };
}

it("follows a thread without replying, including nested replies under its root", async () => {
  const { owner, unread, settled } = await setup();
  const root = event(peer, 10, []);
  const direct = reply(peer, 20, root);
  const nested = reply(peer, 30, root, direct);
  owner.accept([root, direct, nested]);
  await settled(direct, nested);
  const channel = { kind: "channel", channelId: "c0" } as const;
  expect(unread.following("c0", root.id)).toBe(false);
  expect(unread.attention("c0", nested.id)).toMatchObject({
    status: "ineligible",
    unread: false,
  });
  expect(unread.snapshot(channel)).toMatchObject({
    observedCount: 1,
    attentionCount: 0,
  });
  const woken = vi.fn();
  const stop = unread.subscribeSync(woken);

  unread.follow("c0", root.id, true);

  expect(woken).toHaveBeenCalled();
  expect(unread.following("c0", root.id)).toBe(true);
  for (const item of [direct, nested])
    expect(unread.attention("c0", item.id)).toMatchObject({
      status: "eligible",
      category: "thread",
      rootId: root.id,
      unread: true,
    });
  expect(unread.snapshot(channel)).toMatchObject({
    observedCount: 3,
    attentionCount: 2,
  });
  expect(unread.activity("c0").items).toEqual([
    expect.objectContaining({ rootId: root.id, unreadCount: 2 }),
  ]);
  expect(unread.inbox().items).toEqual([
    expect.objectContaining({ rootId: root.id, thread: true }),
  ]);
  stop();
});

it("unfollows a participated thread until the viewer explicitly follows it again", async () => {
  const { owner, unread } = await setup();
  const authored = event(viewer, 10, []);
  const answer = reply(peer, 20, authored);
  const other = event(peer, 11, []);
  const mine = reply(viewer, 21, other);
  const sibling = reply(peer, 22, other);
  const nestedMine = reply(viewer, 23, other, sibling);
  owner.accept([authored, answer, other, mine, sibling, nestedMine]);
  expect(unread.following("c0", authored.id)).toBe(true);
  expect(unread.following("c0", other.id)).toBe(true);
  expect(unread.attention("c0", answer.id).category).toBe("thread");

  unread.follow("c0", authored.id, false);
  unread.follow("c0", other.id, false);

  expect(unread.following("c0", authored.id)).toBe(false);
  expect(unread.attention("c0", answer.id)).toMatchObject({
    status: "ineligible",
    unread: false,
  });
  expect(unread.attention("c0", sibling.id).category).toBeUndefined();
  expect(unread.activity("c0").items).toEqual([]);
  // Replying again does not undo an explicit unfollow; mentions still reach the viewer.
  const later = reply(viewer, 30, authored);
  const peerLater = reply(peer, 31, authored, later);
  const mention = reply(peer, 32, authored, authored, [["p", viewer]]);
  owner.accept([later, peerLater, mention]);
  expect(unread.following("c0", authored.id)).toBe(false);
  expect(unread.attention("c0", peerLater.id).category).toBeUndefined();
  expect(unread.attention("c0", mention.id)).toMatchObject({
    category: "mention",
    unread: true,
  });

  unread.follow("c0", authored.id, true);
  expect(unread.attention("c0", peerLater.id)).toMatchObject({
    category: "thread",
    unread: true,
  });
});

it("follows a thread automatically where the viewer was mentioned", async () => {
  const { owner, unread } = await setup();
  const root = event(peer, 10, []);
  const direct = reply(peer, 20, root);
  const nested = reply(peer, 30, root, direct, [["p", viewer]]);
  owner.accept([root, direct, nested]);
  expect(unread.following("c0", root.id)).toBe(true);
  unread.follow("c0", root.id, false);
  expect(unread.following("c0", root.id)).toBe(false);
  // The mention itself still reaches the viewer.
  expect(unread.attention("c0", nested.id).category).toBe("mention");
});

it("keys choices by channel and canonical root and keeps them across reload", async () => {
  const follows = memoryThreadFollows();
  const first = await setup(follows);
  const root = event(peer, 10, []);
  const answer = reply(peer, 20, root);
  // Another channel's reply that claims the same root is its own thread.
  const elsewhere = event(
    peer,
    21,
    [
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
    ],
    "c1",
  );
  first.owner.accept([root, answer, elsewhere]);
  await first.settled(elsewhere);
  first.unread.follow("c0", root.id.toUpperCase(), true);
  expect(first.unread.following("c0", root.id)).toBe(true);
  expect(first.unread.following("c1", root.id)).toBe(false);
  expect(first.unread.attention("c1", elsewhere.id).category).toBeUndefined();
  first.owner.dispose();

  const second = await setup(follows);
  second.owner.accept([root, answer]);
  expect(second.unread.following("c0", root.id)).toBe(true);
  expect(second.unread.attention("c0", answer.id)).toMatchObject({
    category: "thread",
    unread: true,
  });
  // A decided choice needs no conversation lookup.
  expect(second.reader.read).not.toHaveBeenCalled();
  expect(() => second.unread.follow("missing", root.id, true)).toThrow();
  expect(() => second.unread.follow("c0", "not-an-event", true)).toThrow();
});

it("leaves the saved choice and every projection unchanged when saving fails", async () => {
  const saved = memoryThreadFollows();
  const follows: ThreadFollowStorage = {
    ...saved,
    write() {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    },
  };
  const { owner, unread, settled } = await setup(follows);
  const root = event(peer, 10, []);
  const answer = reply(peer, 20, root);
  owner.accept([root, answer]);
  await settled(answer);
  const woken = vi.fn();
  const stop = unread.subscribeSync(woken);
  expect(() => unread.follow("c0", root.id, true)).toThrow("Quota exceeded");
  expect(woken).not.toHaveBeenCalled();
  expect(unread.following("c0", root.id)).toBe(false);
  expect(unread.attention("c0", answer.id).category).toBeUndefined();
  expect(saved.read().size).toBe(0);
  stop();
});

it("applies another window's saved choice", async () => {
  let changed = () => {};
  let choices = new Map<string, boolean>();
  const follows: ThreadFollowStorage = {
    read: () => choices,
    write(next) {
      choices = new Map(next);
    },
    subscribe(listener) {
      changed = listener;
      return () => {
        changed = () => {};
      };
    },
  };
  const { owner, unread, settled } = await setup(follows);
  const root = event(peer, 10, []);
  const answer = reply(peer, 20, root);
  owner.accept([root, answer]);
  await settled(answer);
  const listener = vi.fn();
  const stop = unread.subscribe({ kind: "channel", channelId: "c0" }, listener);
  choices = new Map([[`c0:${root.id}`, true]]);
  changed();
  expect(unread.following("c0", root.id)).toBe(true);
  expect(listener).toHaveBeenCalled();
  expect(unread.attention("c0", answer.id).category).toBe("thread");
  stop();
});
