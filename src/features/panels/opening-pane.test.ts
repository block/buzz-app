import { expect, it } from "vitest";
import { createNavigationController } from "../navigation/controller";
import { createMemoryHistory } from "../navigation/history";
import { type OpenTarget, parseOpenTarget } from "../navigation/targets";
import { besideInline, openedFromSide, openFromTab } from "./opening-pane";

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

it("hands the inline thread, chosen in the side pane, to its tab", () => {
  const { navigation: navigator } = createNavigationController(
    createMemoryHistory(conversation),
  );
  void navigator.open(inline);
  const tab = { ...conversation, messageId: reply, threadRootId: root };
  openFromTab(navigator, tab, "side");
  const { entry } = navigator.snapshot();
  expect(entry.target).toEqual(tab);
  expect(openedFromSide(navigator, entry.id)).toBe(true);
  // The sheet's visit left with it: Back returns to the conversation.
  navigator.back();
  expect(navigator.snapshot().entry.target).toEqual(conversation);
});

it("retires the saved message-link visit when its projected sheet moves to a tab", () => {
  const controller = createNavigationController(
    createMemoryHistory(conversation),
  );
  const navigator = controller.navigation;
  const link = {
    ...conversation,
    messageId: reply,
    threadRootId: root,
    messageLink: true as const,
  };
  void navigator.open(link);
  const { attempt } = navigator.snapshot();
  expect(
    controller.resolve(attempt, { ...inline, inlineMessage: reply }, true),
  ).toBe(true);

  openFromTab(navigator, link, "side");
  expect(navigator.snapshot().entry.target).toEqual(link);
  navigator.back();
  expect(navigator.snapshot().entry.target).toEqual(conversation);
});
