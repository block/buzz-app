import { assert, expect, it, vi } from "vitest";
import { createMessages } from "./messages";
import { createOutbox } from "./outbox";
import { foldMessages } from "./fold";
import { eventDto, type EventData } from "./events";
import { keypair, message, signed } from "./testing";
import { threadReference } from "./thread-reference";

const author = keypair();
const other = keypair();
const root = message(other, "channel", "A thread", 1);
const nested = message(other, "channel", "Nested", 2, [
  ["e", root.id, "", "reply"],
]);

function setup(events: EventData[] = [root, nested]) {
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
  );
  return { messages, outbox };
}
const sent = (outbox: ReturnType<typeof setup>["outbox"]) => {
  const event = outbox.snapshot()[0]?.event;
  assert.exists(event);
  return event;
};

it("reply_broadcast_showsInChannelTimelineAndKeepsItsThreadReference", () => {
  const { messages, outbox } = setup();
  messages.reply(
    "channel",
    root.id,
    "hello",
    [],
    [],
    root.id,
    [],
    {},
    undefined,
    true,
  );

  const event = sent(outbox);
  expect(event.tags).toContainEqual(["broadcast", "1"]);
  expect(event.tags).toContainEqual(["e", root.id, "", "reply"]);
  expect(threadReference(event)).toEqual({
    rootId: root.id,
    parentId: root.id,
  });
  const channel = foldMessages("channel", author.pubkey, [root, event]);
  expect(channel.map((row) => row.id)).toContain(event.id);
  const thread = foldMessages("channel", author.pubkey, [root, event], {
    includeReplies: true,
  }).find((row) => row.id === event.id);
  expect(thread?.threadRootId).toBe(root.id);
});

it("reply_plain_staysInThread", () => {
  const { messages, outbox } = setup();
  messages.reply("channel", root.id, "hello");

  const event = sent(outbox);
  expect(event.tags.some(([name]) => name === "broadcast")).toBe(false);
  const channel = foldMessages("channel", author.pubkey, [root, event]);
  expect(channel.map((row) => row.id)).not.toContain(event.id);
});

it("reply_broadcastToNestedParent_isRefusedAndPublishesNothing", () => {
  const { messages, outbox } = setup();
  expect(() =>
    messages.reply(
      "channel",
      root.id,
      "hello",
      [],
      [],
      nested.id,
      [],
      {},
      undefined,
      true,
    ),
  ).toThrow(/opening message/);
  expect(outbox.snapshot()).toHaveLength(0);
});

it("forward_broadcast_isOneEventShownInTheChannelAndRefusedForNestedParents", () => {
  const forwarded = eventDto(message(other, "elsewhere", "Read this", 5));
  const row = foldMessages("elsewhere", author.pubkey, [forwarded])[0];
  assert.exists(row);
  const { messages, outbox } = setup([root, nested, forwarded]);

  expect(() =>
    messages.forward("channel", row, "Author", "", undefined, {
      rootId: root.id,
      parentId: nested.id,
      broadcast: true,
    }),
  ).toThrow(/opening message/);
  expect(outbox.snapshot()).toHaveLength(0);

  messages.forward("channel", row, "Author", "", undefined, {
    rootId: root.id,
    broadcast: true,
  });
  const event = sent(outbox);
  expect(event.tags).toContainEqual(["broadcast", "1"]);
  expect(event.tags).toContainEqual(["e", root.id, "", "reply"]);
  expect(
    foldMessages("channel", author.pubkey, [root, event]).map((r) => r.id),
  ).toContain(event.id);
});
