import { assert, expect, it, vi } from "vitest";
import { createMessages } from "./messages";
import { createOutbox } from "./outbox";
import { foldMessages } from "./fold";
import { keypair, message, signed } from "./testing";
import type { EventData } from "./events";

const author = keypair();
const other = keypair();
const root = message(other, "channel", "A thread", 1);
const reply = message(author, "channel", "Hello :wave:", 2, [
  ["e", root.id, "", "reply"],
  ["p", other.pubkey],
  ["emoji", "wave", "https://example.com/wave.png"],
  ["imeta", "url https://example.com/photo.png", "m image/png"],
]);
function setup(events: EventData[] = [root, reply], allowed = true) {
  const writer = {
    kinds: [9],
    sign: vi.fn(async (event) => signed(author, event)),
    publish: vi.fn(async () => {}),
  };
  const { outbox } = createOutbox(author.pubkey, writer, {
    load: () => [],
    save: () => {},
  });
  const messages = createMessages(
    outbox,
    author.pubkey,
    (id) => events.find((event) => event.id === id),
    () => [],
    () => {},
    () => allowed,
  );
  const row =
    foldMessages("channel", other.pubkey, events, {
      includeReplies: true,
    }).find((row) => row.id === reply.id) ??
    foldMessages("channel", other.pubkey, [reply], { includeReplies: true })[0];
  assert.exists(row);
  return { outbox, messages, row, writer };
}
it("signs a fresh top-level message and folds its provenance, emoji, attachment and mention display", async () => {
  const { messages, row, outbox, writer } = setup();
  await outbox.ready();
  messages.sendToChannel(row);
  await vi.waitFor(() => expect(writer.publish).toHaveBeenCalledOnce());
  const event = outbox.snapshot()[0]?.event;
  assert.exists(event);
  expect(event.id).not.toBe(reply.id);
  expect(event.pubkey).toBe(author.pubkey);
  expect(event.kind).toBe(9);
  expect(event.content).toBe(row.content);
  expect(event.tags).toContainEqual(["h", "channel"]);
  expect(event.tags).toContainEqual(["buzz:sent-from-thread", root.id]);
  expect(event.tags.some(([name]) => name === "e" || name === "p")).toBe(false);
  const shared = foldMessages("channel", other.pubkey, [event])[0];
  assert.exists(shared);
  expect(shared.threadRootId).toBeUndefined();
  expect(shared.sentFromThread?.rootId).toBe(root.id);
  expect(shared.emoji).toEqual(row.emoji);
  expect(shared.attachments).toEqual(row.attachments);
  expect(shared.mentionReferences).toEqual([other.pubkey]);
});
it("copies the edited body and edited attachment provenance", () => {
  const edit = signed(author, {
    kind: 40003,
    created_at: 3,
    content: "Edited reply",
    tags: [
      ["e", reply.id],
      ["h", "channel"],
      ["imeta", "url https://example.com/new.png", "m image/png"],
    ],
  });
  const { messages, row, outbox } = setup([root, reply, edit]);
  messages.sendToChannel(row);
  const event = outbox.snapshot()[0]?.event;
  assert.exists(event);
  expect(event.content).toBe("Edited reply");
  expect(event.tags).toContainEqual(edit.tags[2]);
  expect(event.tags).not.toContainEqual(
    reply.tags.find(([name]) => name === "imeta"),
  );
  expect(event.tags.some(([name]) => name === "p")).toBe(false);
});
it("rejects third-party authors, pending messages, mismatched destinations and unavailable membership", () => {
  const { messages, row, outbox } = setup();
  for (const invalid of [
    { ...row, authorId: other.pubkey },
    { ...row, delivery: "sending" as const },
    { ...row, channelId: "elsewhere" },
    { ...row, threadRootId: "a".repeat(64) },
  ]) {
    expect(() => messages.sendToChannel(invalid)).toThrow();
  }
  expect(() => setup([root, reply], false).messages.sendToChannel(row)).toThrow(
    /Join/,
  );
  expect(() => setup([root]).messages.sendToChannel(row)).toThrow(/Load/);
  expect(outbox.snapshot()).toHaveLength(0);
});
it("ignores malformed provenance on received messages", () => {
  const invalid = message(author, "channel", "Hello", 4, [
    ["buzz:sent-from-thread", "invalid"],
  ]);
  expect(
    foldMessages("channel", other.pubkey, [invalid])[0]?.sentFromThread,
  ).toBeUndefined();
});

it("rejects a loaded reply authored by someone else even when the caller changes the displayed author", () => {
  const foreign = message(other, "channel", "Other reply", 3, [
    ["e", root.id, "", "reply"],
  ]);
  const { messages, row, outbox } = setup([root, reply, foreign]);
  expect(() => messages.sendToChannel({ ...row, id: foreign.id })).toThrow(
    /Only your own/,
  );
  expect(outbox.snapshot()).toHaveLength(0);
});
it("preserves attachment-only replies", () => {
  const image = message(author, "channel", "", 3, [
    ["e", root.id, "", "reply"],
    ["imeta", "url https://example.com/photo.png", "m image/png"],
  ]);
  const { messages, outbox } = setup([root, image]);
  const row = foldMessages("channel", other.pubkey, [image], {
    includeReplies: true,
  })[0];
  assert.exists(row);
  messages.sendToChannel(row);
  const event = outbox.snapshot()[0]?.event;
  assert.exists(event);
  expect(event.content).toBe("https://example.com/photo.png");
  expect(
    foldMessages("channel", other.pubkey, [event])[0]?.attachments,
  ).toEqual(row.attachments);
});

it("shares a compact excerpt from the reconciled root, omitting spoilers and markup", () => {
  const { messages, row, outbox } = setup();
  const currentRoot = foldMessages("channel", other.pubkey, [root])[0];
  assert.exists(currentRoot);
  messages.sendToChannel(row, {
    ...currentRoot,
    content:
      "**Updated** [layout](https://example.com) ||secret||\n\n" +
      "😀".repeat(80),
  });
  const tag = outbox
    .snapshot()[0]
    ?.event.tags.find(([name]) => name === "buzz:sent-from-thread");
  expect(tag?.[2]).toMatch(/^Updated layout 😀/);
  expect(tag?.[2]).not.toContain("secret");
  expect(tag?.[2]).not.toContain("https:");
  expect(Array.from(tag?.[2] ?? "")).toHaveLength(64);
  expect(tag?.[2]?.endsWith("…")).toBe(true);
});
it("omits the excerpt when the supplied root belongs to another conversation", () => {
  const { messages, row, outbox } = setup();
  messages.sendToChannel(row, {
    ...row,
    id: root.id,
    channelId: "elsewhere",
    content: "Unrelated",
  });
  expect(outbox.snapshot()[0]?.event.tags).toContainEqual([
    "buzz:sent-from-thread",
    root.id,
  ]);
});
