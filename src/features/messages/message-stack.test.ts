import { describe, expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { messagesStack } from "./message-stack";

const row: ChannelMessage = {
  id: "first",
  channelId: "channel",
  authorId: "author",
  content: "Hello",
  createdAt: 1_790_078_400,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
const next = { ...row, id: "next", createdAt: row.createdAt + 30 };
describe("message stacks", () => {
  it("joins adjacent same-author messages, including the middle of a stack", () => {
    expect(messagesStack(undefined, row)).toBe(false);
    expect(messagesStack(row, next)).toBe(true);
    expect(
      messagesStack(next, {
        ...next,
        id: "last",
        createdAt: next.createdAt + 30,
      }),
    ).toBe(true);
    expect(messagesStack(next, undefined)).toBe(false);
  });
  it("breaks at authors, channels, time gaps and reversed timestamps", () => {
    for (const change of [
      { authorId: "other" },
      { channelId: "other" },
      { createdAt: row.createdAt + 301 },
      { createdAt: row.createdAt - 1 },
    ]) {
      expect(messagesStack(row, { ...next, ...change })).toBe(false);
    }
  });
  it("breaks at local date separators", () => {
    const midnight = new Date(2026, 8, 22).getTime() / 1000;
    expect(
      messagesStack(
        { ...row, createdAt: midnight - 1 },
        { ...next, createdAt: midnight },
      ),
    ).toBe(false);
  });
  it("keeps same-author groups across reaction, reply and delivery feedback", () => {
    expect(messagesStack({ ...row, replyCount: 1 }, next)).toBe(true);
    expect(messagesStack({ ...row, delivery: "failed" }, next)).toBe(true);
    expect(
      messagesStack(
        { ...row, reactions: [{ content: "👍", events: [] }] },
        next,
      ),
    ).toBe(true);
    expect(messagesStack({ ...row, delivery: "seen" }, next)).toBe(true);
  });
});
