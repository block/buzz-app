import { expect, it, vi } from "vitest";
import { keypair, message, signed } from "./testing";
import type { EventData, ReadFilter } from "./events";
import { projectReactionHistory, readReactionPage } from "./reaction-history";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const own = message(viewer, "room", "Release ready", 10);
const foreign = message(other, "room", "Not mine", 11);
const react = (
  target = own,
  content = "✅",
  at = 20,
  key = other,
  room = "room",
) =>
  signed(key, {
    kind: 7,
    content,
    created_at: at,
    tags: [
      ["h", room],
      ["e", target.id],
    ],
  });
const project = (events: EventData[], rooms = ["room"]) =>
  projectReactionHistory(events, viewer.pubkey, relay.pubkey, rooms);

it("finds reactions without p tags, validates message ownership, and excludes self reactions", () => {
  const valid = react();
  const forged = signed(other, {
    kind: 7,
    content: "👀",
    tags: [
      ["h", "room"],
      ["e", foreign.id],
      ["p", viewer.pubkey],
    ],
  });
  expect(
    project([own, foreign, valid, forged, react(own, "✅", 21, viewer)]),
  ).toEqual([
    expect.objectContaining({
      id: valid.id,
      messageId: own.id,
      authorId: other.pubkey,
      preview: "Release ready",
    }),
  ]);
  expect(project([own, valid], [])).toEqual([]);
  expect(project([own, react(own, "✅", 21, other, "elsewhere")])).toEqual([]);
});

it("folds edits and authorized deletion of reactions and messages", () => {
  const reaction = react();
  const edit = signed(viewer, {
    kind: 40003,
    content: "Updated release",
    created_at: 30,
    tags: [
      ["h", "room"],
      ["e", own.id],
    ],
  });
  const forgedDelete = signed(viewer, {
    kind: 5,
    content: "",
    tags: [
      ["h", "room"],
      ["e", reaction.id],
    ],
  });
  expect(project([own, reaction, edit, forgedDelete])[0]?.preview).toBe(
    "Updated release",
  );
  const remove = signed(other, {
    kind: 5,
    content: "",
    tags: [
      ["h", "room"],
      ["e", reaction.id],
    ],
  });
  expect(project([own, reaction, remove])).toEqual([]);
  const removeMessage = signed(viewer, {
    kind: 5,
    content: "",
    tags: [
      ["h", "room"],
      ["e", own.id],
    ],
  });
  expect(project([own, reaction, removeMessage])).toEqual([]);
});

it("retains thread destinations and custom emoji, deduplicates a person's reaction, sorts by reaction time", () => {
  const root = message(other, "room", "Root", 1);
  const reply = message(viewer, "room", "Reply", 2, [
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
  ]);
  const custom = signed(other, {
    kind: 7,
    content: ":ship:",
    created_at: 40,
    tags: [
      ["h", "room"],
      ["e", reply.id],
      ["emoji", "ship", "https://example.com/ship.png"],
    ],
  });
  const rows = project([own, reply, react(), react(own, "✅", 21), custom]);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    id: custom.id,
    rootId: root.id,
    emoji: { shortcode: "ship", url: "https://example.com/ship.png" },
  });
  expect(rows[1]?.createdAt).toBe(21);
});

it("hydrates targets and overlays, and keeps a cursor through sparse history", async () => {
  const reaction = react();
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    const f = filters[0];
    if (f?.kinds?.includes(7)) return [reaction];
    if (f?.ids) return [own];
    return [];
  });
  const page = await readReactionPage(
    { read, viewer: viewer.pubkey, relayAuthor: relay.pubkey },
    ["room"],
    new AbortController().signal,
  );
  expect(page.rows[0]?.id).toBe(reaction.id);
  expect(page.cursor).toEqual({
    until: reaction.created_at,
    before_id: reaction.id,
  });
  expect(read.mock.calls[0]?.[0]).toEqual([
    { kinds: [7], "#h": ["room"], limit: 100 },
  ]);
  await expect(
    readReactionPage(
      { read, viewer: viewer.pubkey, relayAuthor: relay.pubkey },
      ["room"],
      new AbortController().signal,
      page.cursor,
    ),
  ).rejects.toThrow("did not advance");
});

it("does not query without an admitted channel and surfaces failed overlay reads", async () => {
  const read = vi.fn(async () => []);
  await readReactionPage(
    { read, viewer: viewer.pubkey, relayAuthor: relay.pubkey },
    [],
    new AbortController().signal,
  );
  expect(read).not.toHaveBeenCalled();
  const failing = vi
    .fn()
    .mockResolvedValueOnce([react()])
    .mockResolvedValueOnce([own])
    .mockRejectedValueOnce(new Error("offline"));
  await expect(
    readReactionPage(
      { read: failing, viewer: viewer.pubkey, relayAuthor: relay.pubkey },
      ["room"],
      new AbortController().signal,
    ),
  ).rejects.toThrow("offline");
});

it("honors reference-only tombstones for reactions, messages, and edits", () => {
  const reaction = react();
  const edit = signed(viewer, {
    kind: 40003,
    content: "Retracted edit",
    created_at: 30,
    tags: [
      ["h", "room"],
      ["e", own.id],
    ],
  });
  const deleteEdit = signed(viewer, {
    kind: 9005,
    content: "",
    tags: [["e", edit.id]],
  });
  expect(project([own, reaction, edit, deleteEdit])[0]?.preview).toBe(
    "Release ready",
  );
  const deleteReaction = signed(other, {
    kind: 5,
    content: "",
    tags: [["e", reaction.id]],
  });
  expect(project([own, reaction, deleteReaction])).toEqual([]);
  const deleteMessage = signed(viewer, {
    kind: 5,
    content: "",
    tags: [["e", own.id]],
  });
  expect(project([own, reaction, deleteMessage])).toEqual([]);
});
