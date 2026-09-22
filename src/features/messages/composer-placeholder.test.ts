import { expect, it } from "vitest";
import { composerPlaceholder, hasSentMessage } from "./composer-placeholder";
import type { ChannelMessage } from "../relay/contracts";

it.each([
  ["channel", false, "Send a message in #buzz-design"],
  ["channel", true, "Send a message in #buzz-design"],
  ["thread", false, "Reply in thread"],
  ["thread", true, "Reply in thread"],
  ["dm", false, "Start a new message"],
  ["dm", true, "Message..."],
] as const)(
  "uses Figma copy for %s, existing=%s",
  (destination, existing, copy) => {
    expect(composerPlaceholder(destination, existing, "buzz-design")).toBe(
      copy,
    );
  },
);

const row: ChannelMessage = {
  id: "m",
  channelId: "c",
  authorId: "p",
  createdAt: 1,
  content: "Hi",
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
it("uses delivered messages, not membership events or local attempts", () => {
  expect(hasSentMessage([])).toBe(false);
  for (const delivery of ["sending", "failed", "unknown"] as const)
    expect(hasSentMessage([{ ...row, delivery }])).toBe(false);
  for (const delivery of ["accepted", "seen"] as const)
    expect(hasSentMessage([{ ...row, delivery }])).toBe(true);
  expect(hasSentMessage([row])).toBe(true);
  expect(
    hasSentMessage([
      {
        ...row,
        membership: { type: "member_joined", actor: "a", target: "b" },
      },
    ]),
  ).toBe(false);
});
