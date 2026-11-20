// @vitest-environment jsdom
import { FrequentlyUsed } from "emoji-mart";
import { afterEach, expect, it } from "vitest";
import { customEmojiId, emojiUsage, recordEmojiUsage } from "./emoji-usage";

const stored = () =>
  JSON.parse(localStorage.getItem("emoji-mart.frequently") ?? "{}");
afterEach(() => localStorage.clear());

it("reads the picker's counts for Unicode and community suggestions", () => {
  localStorage.setItem(
    "emoji-mart.frequently",
    JSON.stringify({
      smile: 3,
      [customEmojiId("wss://relay.test/a", "party")]: 2,
      odd: "4",
    }),
  );
  const uses = emojiUsage("wss://relay.test/a");
  expect(uses("unicode/smile")).toBe(3);
  expect(uses("custom/party")).toBe(2);
  expect(emojiUsage("wss://relay.test/b")("custom/party")).toBe(0);
  expect(uses("unicode/odd")).toBe(0);
  expect(uses("unicode/constructor")).toBe(0);
  localStorage.setItem("emoji-mart.frequently", "not json");
  expect(emojiUsage("wss://relay.test/a")("unicode/smile")).toBe(0);
});

it("records through Mart so picker and suggestion choices share one history", async () => {
  FrequentlyUsed.add({ id: "joy" }); // a picker choice
  recordEmojiUsage("wss://relay.test/a", "unicode/joy");
  recordEmojiUsage("wss://relay.test/a", "custom/party");
  recordEmojiUsage("wss://relay.test/a", "other/joy");
  await expect.poll(stored).toEqual({
    joy: 2,
    [customEmojiId("wss://relay.test/a", "party")]: 1,
  });
  // A later picker save rewrites Mart's cached counts, keeping both sources.
  FrequentlyUsed.add({ id: "joy" });
  expect(stored()).toEqual({
    joy: 3,
    [customEmojiId("wss://relay.test/a", "party")]: 1,
  });
});
