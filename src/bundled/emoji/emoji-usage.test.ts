// @vitest-environment jsdom
import data from "@emoji-mart/data";
import { FrequentlyUsed, init } from "emoji-mart";
import { afterEach, expect, it } from "vitest";
import "./emoji-mart";
import {
  addEmojiUsage,
  customEmojiId,
  emojiUsage,
  frequentEmoji,
  recordEmojiUsage,
} from "./emoji-usage";

const party = customEmojiId("wss://relay.test/a", "party");
const stored = () =>
  JSON.parse(localStorage.getItem("emoji-mart.frequently") ?? "null");
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

it("counts each choice against the latest history, keeping other windows' choices", () => {
  recordEmojiUsage("wss://relay.test/a", "unicode/smirk");
  // Another window chooses from the same storage.
  localStorage.setItem(
    "emoji-mart.frequently",
    JSON.stringify({ ...stored(), rocket: 1 }),
  );
  recordEmojiUsage("wss://relay.test/a", "custom/party");
  addEmojiUsage("smirk");
  recordEmojiUsage("wss://relay.test/a", "other/joy");
  expect(stored()).toEqual({ smirk: 2, rocket: 1, [party]: 1 });
  expect(localStorage.getItem("emoji-mart.last")).toBe('"smirk"');
  // Unreadable history starts over rather than blocking choices.
  for (const value of ["[1,2]", "null", "garbage"]) {
    localStorage.setItem("emoji-mart.frequently", value);
    addEmojiUsage("smirk");
    expect(stored()).toEqual({ smirk: 1 });
  }
});

it("orders the Frequently used row like Mart, filling a first row with defaults", () => {
  const shown = (id: string) => id !== "hidden";
  const row = (perLine: number, maxFrequentRows = 2) =>
    frequentEmoji(
      { maxFrequentRows, perLine },
      ["+1", "grinning", "joy"],
      shown,
    );
  expect(row(2)).toEqual(["+1", "grinning"]);
  expect(row(2, 0)).toEqual([]);
  localStorage.setItem(
    "emoji-mart.frequently",
    JSON.stringify({ b: 2, a: 2, c: 5, hidden: 9, seeded: 0.5, joy: 1 }),
  );
  // Ties sort by ID; unshown and unchosen entries are skipped.
  expect(row(4)).toEqual(["c", "a", "b", "joy"]);
  expect(row(5)).toEqual(["c", "a", "b", "joy", "+1"]);
  // The latest choice stays in a full row.
  localStorage.setItem("emoji-mart.last", '"joy"');
  expect(row(1)).toEqual(["c", "joy"]);
});

it("keeps Mart's pickers on the shared history", async () => {
  await init({ data });
  FrequentlyUsed.add({ id: "smirk" });
  expect(stored()).toBeNull();
  addEmojiUsage("smirk");
  const mart = FrequentlyUsed as unknown as {
    get(props: { maxFrequentRows: number; perLine: number }): string[];
  };
  expect(mart.get({ maxFrequentRows: 1, perLine: 2 })).toEqual(["smirk", "+1"]);
});
