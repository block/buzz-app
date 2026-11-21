import { expect, it } from "vitest";
import { type InboxItem, needsYouChannels } from "./inbox";

const item = (fields: Partial<InboxItem>): InboxItem => ({
  id: "room:root",
  channelId: "room",
  target: { kind: "thread", channelId: "room", rootId: "root" },
  messageId: "root",
  latestMessageId: "root",
  messageIds: ["root"],
  authorId: "alice",
  preview: "",
  previewMentions: { content: "", mentions: [] },
  createdAt: 10,
  mentioned: false,
  messages: [],
  thread: true,
  unreadCount: 0,
  manual: false,
  readThrough: [],
  ...fields,
});
it("counts a channel as waiting only while one of its conversations is unread", () => {
  const unread = (items: InboxItem[]) =>
    needsYouChannels({ status: "ready", items, freshness: "observed" });
  // A read conversation lingers in Activity but leaves its channel's backlog alone.
  expect(unread([item({ unreadCount: 0, manual: false })])).toEqual(new Set());
  expect(unread([item({ unreadCount: 2 })])).toEqual(new Set(["room"]));
  expect(unread([item({ manual: true })])).toEqual(new Set(["room"]));
});
