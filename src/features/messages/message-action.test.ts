import { expect, it } from "vitest";
import { actionMessageContent, messageAction } from "./message-action";
import type { ChannelMessage } from "../relay/contracts";

it("recognizes only a leading lowercase /me command with a body", () => {
  for (const [content, expected] of [
    ["/me passes out", "passes out"],
    ["/me  eats a drumstick  ", "eats a drumstick"],
    ["/me waves\nand sits down", "waves\nand sits down"],
    ["/me", undefined],
    ["/me   ", undefined],
    ["/meeting", undefined],
    ["/ME waves", undefined],
    [" /me waves", undefined],
    ["/me\twaves", undefined],
    ["\\/me waves", undefined],
    ["`/me waves`", undefined],
    ["> /me waves", undefined],
    ["```\n/me waves\n```", undefined],
    ["Try /me waves", undefined],
  ] as const) {
    expect(messageAction(content), content).toBe(expected);
  }
});

it("moves attachment seams with the display prefix without changing the source", () => {
  const row: ChannelMessage = {
    id: "action",
    channelId: "channel",
    authorId: "author",
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    content: "/me   waves @Sam  ",
    attachmentSeams: [0, 4, 6, 12, 16, 18],
  };
  const displayed = actionMessageContent(row);
  expect(displayed.content).toBe("waves @Sam");
  expect(displayed.attachmentSeams).toEqual([0, 6, 10]);
  expect(row.content).toBe("/me   waves @Sam  ");
  expect(row.attachmentSeams).toEqual([0, 4, 6, 12, 16, 18]);
});
