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

it("seeds one default row below one choice, only into a store without choices", () => {
  const stored = () =>
    JSON.parse(localStorage.getItem("emoji-mart.frequently") ?? "");
  seedEmojiUsage(["+1", "grinning", "kissing_heart"], 2);
  expect(Object.keys(stored())).toEqual(["+1", "grinning"]);
  expect(stored()["+1"]).toBeGreaterThan(stored().grinning);
  expect(stored()["+1"]).toBeLessThan(1);
  expect(emojiUsage("s")("unicode/+1")).toBe(0);
  localStorage.setItem("emoji-mart.frequently", JSON.stringify({ smile: 1 }));
  seedEmojiUsage(["+1"], 1);
  expect(stored()).toEqual({ smile: 1 });
  // A wider picker widens a seeded row, never a row with choices.
  localStorage.clear();
  seedEmojiUsage(["+1", "grinning"], 1);
  seedEmojiUsage(["+1", "grinning", "kissing_heart"], 3);
  expect(Object.keys(stored())).toEqual(["+1", "grinning", "kissing_heart"]);
  seedEmojiUsage(["+1"], 1);
  expect(Object.keys(stored())).toHaveLength(3);
  localStorage.setItem(
    "emoji-mart.frequently",
    JSON.stringify({ smile: 1, "+1": 0.5 }),
  );
  seedEmojiUsage(["+1", "grinning", "kissing_heart"], 3);
  expect(stored()).toEqual({ smile: 1, "+1": 0.5 });
  // Empty and malformed stores get the default row back.
  for (const value of [
    "{}",
    "[]",
    "[1,2]",
    "null",
    "",
    "0",
    "false",
    "garbage",
  ]) {
    localStorage.setItem("emoji-mart.frequently", value);
    seedEmojiUsage(["+1"], 1);
    expect(Object.keys(stored())).toEqual(["+1"]);
  }
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
  // Without a picker width, the seed is the widest picker row.
  expect(Object.keys(stored).sort()).toEqual(
    [...FrequentlyUsed.DEFAULTS.slice(0, 8), party].sort(),
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
