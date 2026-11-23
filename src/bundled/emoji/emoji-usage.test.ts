// @vitest-environment jsdom
import data from "@emoji-mart/data";
import { Data, FrequentlyUsed, init } from "emoji-mart";
import { afterEach, expect, it, vi } from "vitest";
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

it("removes the defaults Mart stored as picks once, keeping real picks", () => {
  // What Mart 5.6 saves at perLine 9 (module.js:487-505): its seed, then the
  // picks rocket once and grinning twice.
  const seed = [
    "+1",
    "grinning",
    "kissing_heart",
    "heart_eyes",
    "laughing",
    "stuck_out_tongue_winking_eye",
    "sweat_smile",
    "joy",
    "scream",
  ];
  const mart: Record<string, number> = Object.fromEntries(
    seed.map((id, i) => [id, 9 - i]),
  );
  mart.grinning = (mart.grinning ?? 0) + 2;
  mart.rocket = 1;
  localStorage.setItem("emoji-mart.frequently", JSON.stringify(mart));
  const uses = emojiUsage("s");
  expect(uses("unicode/rocket")).toBe(1);
  expect(uses("unicode/grinning")).toBe(2);
  expect(uses("unicode/+1")).toBe(0);
  expect(uses("unicode/scream")).toBe(0);
  expect(stored()).toEqual({ grinning: 2, rocket: 1 });
  // Only once: later counts that look like a seed are real picks.
  localStorage.setItem("emoji-mart.frequently", JSON.stringify({ "+1": 1 }));
  expect(emojiUsage("s")("unicode/+1")).toBe(1);
});

it.each(["buzz.emoji-usage.seed-removed", "emoji-mart.frequently"])(
  "never subtracts the seed twice when storage refuses %s",
  (refused) => {
    const values = new Map([
      ["emoji-mart.frequently", JSON.stringify({ "+1": 5, rocket: 3 })],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === refused)
          throw new DOMException("full", "QuotaExceededError");
        values.set(key, value);
      },
    });
    try {
      // The seed stays counted rather than costing real picks on each read.
      for (let read = 0; read < 3; read++) emojiUsage("s");
      expect(emojiUsage("s")("unicode/+1")).toBe(5);
      expect(emojiUsage("s")("unicode/rocket")).toBe(3);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

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
  // Mart drops emoji newer than the client renders from their categories
  // first; those leave the row to the defaults rather than an empty slot.
  const category: { emojis: string[] } = Data.categories.find(
    (category: { emojis: string[] }) => category.emojis.includes("smirk"),
  );
  const at = category.emojis.indexOf("smirk");
  category.emojis.splice(at, 1);
  try {
    expect(mart.get({ maxFrequentRows: 1, perLine: 2 })).toEqual([
      "+1",
      "grinning",
    ]);
  } finally {
    category.emojis.splice(at, 0, "smirk");
  }
});
