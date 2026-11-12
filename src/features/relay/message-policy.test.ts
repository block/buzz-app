import { expect, it } from "vitest";
import {
  canStartMessage,
  canReplyToPublisher,
  validatePublisherMessage,
} from "./message-policy";
import {
  channelMessagePublisher,
  detailsTemplate,
  validateDetailsTemplate,
} from "./channel-details-protocol";
import type { ChannelMessage, ChannelSummary } from "./contracts";
import type { EventData } from "./events";
const publisher = "a".repeat(64),
  viewer = "b".repeat(64),
  id = "11111111-1111-4111-8111-111111111111";
const channel: ChannelSummary = {
  id,
  name: "Updates",
  visibility: "public",
  messagePublisher: publisher,
  readOnly: true,
  viewerRole: "guest",
};
const root: ChannelMessage = {
  id: "c".repeat(64),
  channelId: id,
  authorId: publisher,
  content: "Update",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
const event: EventData = {
  id: root.id,
  pubkey: publisher,
  kind: 9,
  created_at: 1,
  content: "Update",
  tags: [["h", id]],
};
const reply = {
  kind: 9,
  tags: [
    ["h", id],
    ["e", root.id, "", "reply"],
  ],
};
it.each(["guest", "member", "admin", "owner", "bot", undefined] as const)(
  "separates root and reply capabilities for %s",
  (role) => {
    const current = { ...channel, viewerRole: role };
    expect(canStartMessage(current, viewer)).toBe(false);
    expect(canStartMessage(current, publisher)).toBe(true);
    expect(canReplyToPublisher(current, root)).toBe(true);
    expect(canReplyToPublisher(current, { ...root, authorId: viewer })).toBe(
      false,
    );
    expect(
      canReplyToPublisher(current, { ...root, channelId: "foreign" }),
    ).toBe(false);
    expect(
      canReplyToPublisher(current, { ...root, threadRootId: "d".repeat(64) }),
    ).toBe(false);
  },
);
it("keeps cached, archived, malformed and ordinary channels gated", () => {
  for (const current of [
    { ...channel, cached: true as const },
    { ...channel, metadataCached: true as const },
    { ...channel, archived: true as const },
    { ...channel, messagePublisher: "invalid" },
  ]) {
    expect(canStartMessage(current, publisher)).toBe(false);
    expect(canReplyToPublisher(current, root)).toBe(false);
  }
  expect(
    canStartMessage({ ...channel, messagePublisher: undefined }, viewer),
  ).toBe(false);
  expect(channelMessagePublisher({ tags: [] })).toBeUndefined();
  expect(
    channelMessagePublisher({
      tags: [
        ["message_publisher", publisher],
        ["message_publisher", viewer],
      ],
    }),
  ).toBe("invalid");
});
it("rechecks publisher identity, genuine roots, broadcast and edits at publication", () => {
  const find = (key: string) => (key === event.id ? event : undefined);
  expect(validatePublisherMessage(channel, reply, viewer, find)).toBe(true);
  expect(() =>
    validatePublisherMessage(
      channel,
      {
        kind: 9,
        tags: [
          ["h", id],
          ["actor", publisher],
        ],
      },
      viewer,
      find,
    ),
  ).toThrow();
  for (const invalid of [
    undefined,
    { ...event, pubkey: viewer },
    { ...event, kind: 9002 },
    { ...event, tags: [["h", "foreign"]] },
    { ...event, tags: [...event.tags, ["e", "d".repeat(64), "", "reply"]] },
  ])
    expect(() =>
      validatePublisherMessage(channel, reply, viewer, () => invalid),
    ).toThrow();
  expect(() =>
    validatePublisherMessage(
      channel,
      { ...reply, tags: [...reply.tags, ["broadcast", "1"]] },
      viewer,
      find,
    ),
  ).toThrow();
  expect(() =>
    validatePublisherMessage(
      channel,
      {
        kind: 40003,
        tags: [
          ["h", id],
          ["e", root.id],
        ],
      },
      viewer,
      find,
    ),
  ).toThrow();
});
it("uses explicit policy changes, preserving an unchanged publisher and clearing intentionally", () => {
  const base = {
    name: "updates",
    description: "",
    visibility: "public" as const,
    messagePublisher: publisher,
  };
  expect(
    detailsTemplate(id, base, base).tags.some(
      ([key]) => key === "message_publisher",
    ),
  ).toBe(false);
  const cleared = detailsTemplate(id, { ...base, messagePublisher: "" }, base);
  expect(cleared.tags).toContainEqual(["message_publisher", ""]);
  expect(() => validateDetailsTemplate(cleared)).not.toThrow();
  const changed = detailsTemplate(
    id,
    { ...base, messagePublisher: viewer },
    base,
  );
  expect(() => validateDetailsTemplate(changed)).not.toThrow();
  expect(() =>
    validateDetailsTemplate({
      ...changed,
      tags: [...changed.tags, ["message_publisher", publisher]],
    }),
  ).toThrow();
});

it("rejects root-only references from publishers and stored roots", () => {
  const rootOnly = {
    ...event,
    tags: [...event.tags, ["e", "d".repeat(64), "", "root"]],
  };
  expect(() =>
    validatePublisherMessage(channel, rootOnly, publisher, () => undefined),
  ).toThrow("Root-only");
  expect(() =>
    validatePublisherMessage(channel, reply, viewer, () => rootOnly),
  ).toThrow();
});
