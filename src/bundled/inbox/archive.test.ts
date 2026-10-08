// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InboxItem } from "../../features/relay/inbox";
import { keypair, message } from "../../features/relay/testing";
import { viewRevision } from "../../shared/view-state";
import {
  archiveKey,
  archiveIndex,
  isArchived,
  readArchives,
  reopenArchives,
  updateArchive,
} from "./archive";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const viewer = keypair(),
    alice = keypair();
  const mention = message(alice, "room", "Please review", 20, [
    ["p", viewer.pubkey],
  ]);
  const events = new Map([[mention.id, mention]]);
  const item: InboxItem = {
    id: `room:${mention.id}`,
    channelId: "room",
    target: { kind: "message", channelId: "room", messageId: mention.id },
    messageId: mention.id,
    latestMessageId: mention.id,
    messageIds: [mention.id],
    authorId: alice.pubkey,
    preview: mention.content,
    createdAt: 20,
    mentioned: true,
    mentions: [{ id: mention.id, createdAt: mention.created_at }],
    thread: false,
    unreadCount: 1,
    manual: false,
    readThrough: [],
  };
  const scope = `https://relay.test:${viewer.pubkey}`;
  const archived = (row = item) =>
    isArchived(
      archiveIndex(readArchives(viewRevision(scope, archiveKey))),
      row,
    );
  vi.spyOn(Date, "now").mockReturnValue(30_000);
  return { viewer, alice, events, item, scope, archived };
}

it("keeps observed mentions and ordinary replies archived, but reopens for a same-second new tag", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  expect(h.archived()).toBe(true);
  const add = (at: number, tag: boolean) => {
    const event = message(
      h.alice,
      "room",
      `Update at ${at}`,
      at,
      tag ? [["p", h.viewer.pubkey]] : [],
    );
    h.events.set(event.id, event);
    return {
      ...h.item,
      latestMessageId: event.id,
      messageIds: [...h.item.messageIds, event.id],
      createdAt: at,
      mentions: [
        ...h.item.mentions,
        ...(tag ? [{ id: event.id, createdAt: at }] : []),
      ],
    };
  };
  expect(h.archived(add(40, false))).toBe(true);
  expect(h.archived(add(29, true))).toBe(true);
  const reopened = add(30, true);
  expect(h.archived(reopened)).toBe(false);
  reopenArchives(h.scope, [reopened]);
  expect(readArchives(viewRevision(h.scope, archiveKey))).toEqual([]);
  expect(h.archived()).toBe(false);
});

it("preserves archive intent when exact conversation evidence regroups and restores it", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  const regrouped = { ...h.item, id: "room:root" };
  expect(h.archived(regrouped)).toBe(true);
  expect(h.archived({ ...regrouped, channelId: "another-room" })).toBe(false);
  updateArchive(h.scope, regrouped, false);
  expect(h.archived(regrouped)).toBe(false);
});

it("persists a regrouped archive coordinate after its original evidence is replaced", () => {
  const h = fixture();
  const rootId = "a".repeat(64);
  const reply = message(h.alice, "room", "Unresolved reply", 20, [
    ["e", rootId, "", "reply"],
  ]);
  const unresolvedReply: InboxItem = {
    ...h.item,
    id: `room:${reply.id}`,
    target: { kind: "message", channelId: "room", messageId: reply.id },
    messageId: reply.id,
    latestMessageId: reply.id,
    messageIds: [reply.id],
    createdAt: reply.created_at,
    mentioned: false,
    mentions: [],
    thread: true,
  };
  updateArchive(h.scope, unresolvedReply, true);
  expect(h.archived(unresolvedReply)).toBe(true);

  const regrouped: InboxItem = {
    ...unresolvedReply,
    id: `room:${rootId}`,
    rootId,
    messageIds: [reply.id, "b".repeat(64)],
  };
  reopenArchives(h.scope, [regrouped]);
  const laterReplies: InboxItem = {
    ...regrouped,
    messageId: "c".repeat(64),
    latestMessageId: "c".repeat(64),
    messageIds: ["c".repeat(64)],
    createdAt: 40,
    mentions: [],
  };
  expect(h.archived(laterReplies)).toBe(true);

  const saved = readArchives(viewRevision(h.scope, archiveKey));
  expect(saved).toEqual([
    {
      id: regrouped.id,
      channelId: h.item.channelId,
      through: 30,
      messageIds: [reply.id],
    },
  ]);
});

it.each([2, 40, 54])(
  "keeps a grouped archive stable while its evidence splits into %i unresolved rows",
  (count) => {
    const h = fixture();
    const items: InboxItem[] = Array.from({ length: count }, (_, index) => {
      const id = (index + 1).toString(16).padStart(64, "0");
      return {
        ...h.item,
        id: `room:${id}`,
        messageId: id,
        latestMessageId: id,
        messageIds: [id],
        target: { kind: "message", channelId: "room", messageId: id },
        mentioned: false,
        mentions: [],
        thread: true,
      };
    });
    const rootId = "f".repeat(64);
    const grouped: InboxItem = {
      ...h.item,
      id: `room:${rootId}`,
      rootId,
      target: { kind: "thread", channelId: "room", rootId },
      messageIds: items.flatMap((item) => item.messageIds),
      mentioned: false,
      mentions: [],
      thread: true,
    };
    updateArchive(h.scope, grouped, true);
    const unrelated = { ...h.item, channelId: "other-room" };
    updateArchive(h.scope, unrelated, true);
    const draftKey = `buzz-view.v1:${JSON.stringify([h.scope, "draft:room"])}`;
    localStorage.setItem(draftKey, JSON.stringify("Unsent draft"));
    const original = viewRevision(h.scope, archiveKey);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    for (const evidence of [items, items, [...items].reverse()]) {
      reopenArchives(h.scope, evidence);
      expect(viewRevision(h.scope, archiveKey)).toBe(original);
      expect(evidence.every(h.archived)).toBe(true);
    }
    // Even a single remaining unresolved reply must not downgrade the root.
    reopenArchives(h.scope, items.slice(0, 1));
    reopenArchives(h.scope, [grouped]);
    reopenArchives(h.scope, [grouped]);
    expect(viewRevision(h.scope, archiveKey)).toBe(original);
    expect(writes).not.toHaveBeenCalled();
    expect(localStorage.getItem(draftKey)).toBe(JSON.stringify("Unsent draft"));
    expect(h.archived(unrelated)).toBe(true);
  },
);

it.each([false, true])(
  "does not choose between ambiguous rows when the saved coordinate matches one: %s",
  (matchesCurrent) => {
    const h = fixture();
    const secondId = "b".repeat(64);
    const second: InboxItem = {
      ...h.item,
      id: `room:${secondId}`,
      target: { kind: "message", channelId: "room", messageId: secondId },
      messageId: secondId,
      latestMessageId: secondId,
      messageIds: [secondId],
      mentions: [],
      thread: true,
    };
    const saved = {
      ...h.item,
      id: matchesCurrent ? second.id : "room:old-coordinate",
      messageIds: [...h.item.messageIds, secondId],
    };
    updateArchive(h.scope, saved, true);
    const original = viewRevision(h.scope, archiveKey);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const unresolved = { ...h.item, thread: true };
    for (const evidence of [
      [unresolved, second],
      [second, unresolved],
    ]) {
      reopenArchives(h.scope, evidence);
      expect(viewRevision(h.scope, archiveKey)).toBe(original);
    }
    expect(writes).not.toHaveBeenCalled();
    const rootId = "a".repeat(64);
    const grouped: InboxItem = {
      ...saved,
      id: `room:${rootId}`,
      rootId,
      target: { kind: "thread", channelId: "room", rootId },
    };
    reopenArchives(h.scope, [grouped]);
    expect(readArchives(viewRevision(h.scope, archiveKey))).toEqual([
      {
        id: grouped.id,
        channelId: "room",
        through: 30,
        messageIds: saved.messageIds,
      },
    ]);
    writes.mockClear();
    for (const evidence of [
      [grouped],
      [unresolved, second],
      [second],
      [grouped],
    ])
      reopenArchives(h.scope, evidence);
    expect(writes).not.toHaveBeenCalled();
  },
);

it("does not rewrite a lone unresolved reply or choose between verified root matches", () => {
  const h = fixture();
  const secondId = "b".repeat(64);
  const rootId = "a".repeat(64);
  updateArchive(
    h.scope,
    {
      ...h.item,
      id: `room:${rootId}`,
      messageIds: [...h.item.messageIds, secondId],
    },
    true,
  );
  const original = viewRevision(h.scope, archiveKey);
  const writes = vi.spyOn(Storage.prototype, "setItem");
  reopenArchives(h.scope, [{ ...h.item, thread: true }]);
  expect(viewRevision(h.scope, archiveKey)).toBe(original);
  const first: InboxItem = {
    ...h.item,
    id: `room:${rootId}`,
    rootId,
    target: { kind: "thread", channelId: "room", rootId },
    thread: true,
  };
  const second: InboxItem = {
    ...first,
    id: `room:${secondId}`,
    rootId: secondId,
    target: { kind: "thread", channelId: "room", rootId: secondId },
    messageIds: [secondId],
    mentions: [],
  };
  for (const evidence of [
    [first, second],
    [second, first],
  ]) {
    reopenArchives(h.scope, evidence);
    expect(viewRevision(h.scope, archiveKey)).toBe(original);
  }
  expect(writes).not.toHaveBeenCalled();
});

it("retires an ambiguous archive for a fresh mention without changing unrelated intent", () => {
  const h = fixture();
  const secondId = "b".repeat(64);
  updateArchive(
    h.scope,
    { ...h.item, messageIds: [...h.item.messageIds, secondId] },
    true,
  );
  const unrelated = { ...h.item, channelId: "other-room" };
  updateArchive(h.scope, unrelated, true);
  const fresh = {
    ...h.item,
    id: `room:${secondId}`,
    messageIds: [secondId, "c".repeat(64)],
    mentions: [{ id: "c".repeat(64), createdAt: 30 }],
    thread: true,
  };
  const writes = vi.spyOn(Storage.prototype, "setItem");
  reopenArchives(h.scope, [h.item, fresh]);
  expect(h.archived(h.item)).toBe(false);
  expect(h.archived(fresh)).toBe(false);
  expect(h.archived(unrelated)).toBe(true);
  expect(writes).toHaveBeenCalledTimes(1);
  writes.mockClear();
  reopenArchives(h.scope, [fresh, h.item]);
  expect(writes).not.toHaveBeenCalled();
});

it("partitions archives by community and viewer, and never hides a failed save", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  expect(
    readArchives(viewRevision("https://other.test:viewer", archiveKey)),
  ).toEqual([]);
  expect(
    readArchives(
      viewRevision(`https://relay.test:${h.alice.pubkey}`, archiveKey),
    ),
  ).toEqual([]);
  updateArchive(h.scope, h.item, false);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("disk full");
  });
  expect(() => updateArchive(h.scope, h.item, true)).toThrow("Could not save");
  expect(h.archived()).toBe(false);
});

it("ignores malformed archive records", () => {
  expect(readArchives("{bad json")).toEqual([]);
  expect(
    readArchives(
      '[{"id":"room:root","channelId":"room","through":0,"messageIds":["invalid"]}]',
    ),
  ).toEqual([]);
});

it("reconciles duplicate reopening effects without reporting a failed save", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  const revision = viewRevision(h.scope, archiveKey);
  const tag = message(h.alice, "room", "New request", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const reopened = {
    ...h.item,
    messageIds: [...h.item.messageIds, tag.id],
    mentions: [...h.item.mentions, { id: tag.id, createdAt: 30 }],
  };
  reopenArchives(h.scope, [reopened], revision);
  expect(() => reopenArchives(h.scope, [reopened], revision)).not.toThrow();
  expect(readArchives(viewRevision(h.scope, archiveKey))).toEqual([]);
});

it("does not overwrite a newer archive intent when reopening an older revision", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  const revision = viewRevision(h.scope, archiveKey);
  const tag = message(h.alice, "room", "New request", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const reopened = {
    ...h.item,
    messageIds: [...h.item.messageIds, tag.id],
    mentions: [...h.item.mentions, { id: tag.id, createdAt: 30 }],
  };
  updateArchive(h.scope, reopened, true);
  const latest = viewRevision(h.scope, archiveKey);
  expect(() => reopenArchives(h.scope, [reopened], revision)).not.toThrow();
  expect(viewRevision(h.scope, archiveKey)).toBe(latest);
  expect(h.archived(reopened)).toBe(true);
});

it("reports a genuine reopening write failure without retiring the archive", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  const revision = viewRevision(h.scope, archiveKey);
  const tag = message(h.alice, "room", "New request", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const reopened = {
    ...h.item,
    messageIds: [...h.item.messageIds, tag.id],
    mentions: [...h.item.mentions, { id: tag.id, createdAt: 30 }],
  };
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("disk full");
  });
  expect(() => reopenArchives(h.scope, [reopened], revision)).toThrow(
    "Could not save the reopened Inbox conversation",
  );
  expect(viewRevision(h.scope, archiveKey)).toBe(revision);
});
