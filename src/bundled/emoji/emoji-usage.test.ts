// @vitest-environment jsdom
import { FrequentlyUsed } from "emoji-mart";
import { afterEach, expect, it } from "vitest";
import {
  customEmojiId,
  emojiUsage,
  recordEmojiUsage,
  seedEmojiUsage,
} from "./emoji-usage";

const party = customEmojiId("wss://relay.test/a", "party");
afterEach(() => localStorage.clear());

it("reads whole choices from the picker's counts for Unicode and community suggestions", () => {
  localStorage.setItem(
    "emoji-mart.frequently",
    JSON.stringify({
      smile: 3,
      [party]: 2.5,
      seeded: 0.9,
      odd: "4",
    }),
  );
  const uses = emojiUsage("wss://relay.test/a");
  expect(uses("unicode/smile")).toBe(3);
  expect(uses("custom/party")).toBe(2);
  expect(emojiUsage("wss://relay.test/b")("custom/party")).toBe(0);
  expect(uses("unicode/seeded")).toBe(0);
  expect(uses("unicode/odd")).toBe(0);
  expect(uses("unicode/constructor")).toBe(0);
  // JSON parses an out-of-range count as Infinity.
  localStorage.setItem("emoji-mart.frequently", '{"huge":1e400}');
  expect(emojiUsage("s")("unicode/huge")).toBe(0);
  localStorage.setItem("emoji-mart.frequently", "not json");
  expect(emojiUsage("wss://relay.test/a")("unicode/smile")).toBe(0);
});

it("seeds the default row below one choice, only into an empty store", () => {
  seedEmojiUsage(["+1", "grinning"]);
  const seeded = JSON.parse(
    localStorage.getItem("emoji-mart.frequently") ?? "",
  );
  expect(seeded["+1"]).toBeGreaterThan(seeded.grinning);
  expect(seeded["+1"]).toBeLessThan(1);
  expect(emojiUsage("s")("unicode/+1")).toBe(0);
  localStorage.setItem("emoji-mart.frequently", '{"smile":1}');
  seedEmojiUsage(["+1"]);
  expect(localStorage.getItem("emoji-mart.frequently")).toBe('{"smile":1}');
  // A poisoned empty map gets the default row back.
  localStorage.setItem("emoji-mart.frequently", "{}");
  seedEmojiUsage(["+1"]);
  expect(emojiUsage("s")("unicode/+1")).toBe(0);
  expect(localStorage.getItem("emoji-mart.frequently")).not.toBe("{}");
});

// Mart caches its counts for the module's lifetime, so this runs as one story.
it("records through Mart so picker and suggestion choices share one seeded history", async () => {
  // The first choice, from suggestions, still seeds Mart's default row.
  recordEmojiUsage("wss://relay.test/a", "custom/party");
  recordEmojiUsage("wss://relay.test/a", "other/joy");
  const uses = () => emojiUsage("wss://relay.test/a");
  await expect.poll(() => uses()("custom/party")).toBe(1);
  const stored = JSON.parse(
    localStorage.getItem("emoji-mart.frequently") ?? "",
  );
  expect(Object.keys(stored)).toEqual(
    expect.arrayContaining([...FrequentlyUsed.DEFAULTS, party]),
  );
  expect(uses()("unicode/joy")).toBe(0);
  // A picker choice of a default and a suggestion choice add whole choices.
  FrequentlyUsed.add({ id: "joy" });
  recordEmojiUsage("wss://relay.test/a", "unicode/joy");
  await expect.poll(() => uses()("unicode/joy")).toBe(2);
  // A later picker save rewrites Mart's cached counts, keeping both sources.
  FrequentlyUsed.add({ id: "joy" });
  expect(uses()("unicode/joy")).toBe(3);
  expect(uses()("custom/party")).toBe(1);
  expect(uses()("unicode/+1")).toBe(0);
});
