import { expect, it } from "vitest";
import { type OpenTarget, parseOpenTarget } from "../navigation/targets";
import { besideInline } from "./opening-pane";

const root = "b".repeat(64);
const reply = "c".repeat(64);
const conversation: OpenTarget = {
  version: 1,
  kind: "conversation",
  scope: { viewer: "a".repeat(64), communityOrigin: "https://example.org" },
  channelId: "alpha",
};
const inline = { ...conversation, inline: root };

it("keeps the inline thread in the visit of a tab opened beside it", () => {
  const other = "d".repeat(64);
  const tab = { ...conversation, messageId: reply, threadRootId: other };
  const kept = besideInline({ ...inline, inlineMessage: reply }, tab);
  expect(kept).toEqual({ ...tab, inline: root, inlineMessage: reply });
  // The address stays one the host accepts.
  expect(parseOpenTarget(kept)).toEqual(kept);
  // The inline thread's own tab takes it, and other conversations and
  // openings are not this conversation's to change.
  const own = { ...conversation, messageId: reply, threadRootId: root };
  expect(besideInline(inline, own)).toBe(own);
  expect(besideInline({ ...inline, channelId: "beta" }, tab)).toBe(tab);
  expect(besideInline(conversation, tab)).toBe(tab);
  expect(besideInline(inline, conversation)).toBe(conversation);
});
