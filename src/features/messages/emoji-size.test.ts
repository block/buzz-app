import { expect, it } from "vitest";
import {
  isEmojiOnly,
  isUnicodeEmojiOnly,
  MAX_LARGE_EMOJI,
  usesLargeEmojiPresentation,
} from "./emoji-size";

it("recognizes Unicode emoji sequences without enlarging ordinary prose", () => {
  for (const emoji of ["😀", " 👋🏽 ", "👨‍👩‍👧‍👦", "🇬🇧", "1️⃣"])
    expect(isUnicodeEmojiOnly(emoji)).toBe(true);
  for (const other of ["", "1", ":party:", "😀a", "😀 hello"])
    expect(isUnicodeEmojiOnly(other)).toBe(false);
});

it("recognizes custom emoji without treating shortcode prose as emoji", () => {
  const party = { shortcode: "party", url: "https://example.test/party.png" };
  expect(isEmojiOnly(":party: 😀 :PARTY:", [party])).toBe(true);
  expect(isEmojiOnly(":party: hello", [party])).toBe(false);
  expect(usesLargeEmojiPresentation(":party: 😀 :PARTY:", [party])).toBe(true);
  expect(
    usesLargeEmojiPresentation(":party: 😀 :PARTY: :party:", [party]),
  ).toBe(true);
});

it("shows up to nine emoji large and longer runs at text size", () => {
  const party = { shortcode: "party", url: "https://example.test/party.png" };
  expect(MAX_LARGE_EMOJI).toBe(9);
  expect(usesLargeEmojiPresentation("😀".repeat(9))).toBe(true);
  expect(usesLargeEmojiPresentation(" 😀 👨‍👩‍👧‍👦 🇬🇧 ".repeat(3))).toBe(true);
  expect(usesLargeEmojiPresentation("😀".repeat(10))).toBe(false);
  expect(
    usesLargeEmojiPresentation(`${":party:".repeat(5)}${"😀".repeat(5)}`, [
      party,
    ]),
  ).toBe(false);
  expect(isEmojiOnly("😀".repeat(30))).toBe(true);
});
