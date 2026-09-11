import { expect, it } from "vitest";
import { emojiQuery } from "./emoji-query";
it("opens after two shortcode characters, at the real caret and word boundaries", () => {
  expect(emojiQuery("(:sm tail", 4)).toEqual({ start: 1, end: 4, query: "sm" });
  expect(emojiQuery(":+1", 3)?.query).toBe("+1");
  expect(emojiQuery("🧠 :party-parrot", 16)?.query).toBe("party-parrot");
  for (const text of [
    ":",
    ":s",
    ":smile:",
    "12:30",
    "https://site",
    "word:sm",
    ":sm ile",
    `:${"a".repeat(65)}`,
  ]) {
    expect(emojiQuery(text, text.length)).toBeNull();
  }
});
