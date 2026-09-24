// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { quickReactions, recordReaction } from "./quick-reactions";
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it("ranks saved reactions per viewer/community and filters unavailable custom emoji", () => {
  recordReaction("one:viewer", "🎉");
  recordReaction("one:viewer", "🎉");
  recordReaction("one:viewer", ":party:");
  expect(quickReactions("one:viewer", [])).toEqual(["🎉", "👍", "❤️"]);
  expect(
    quickReactions("one:viewer", [
      { shortcode: "party", url: "https://a.test/p" },
    ]),
  ).toEqual(["🎉", ":party:", "👍"]);
  expect(quickReactions("one:other", [])).toEqual(["👍", "❤️", "😂"]);
});
it("falls back safely with corrupt data or unavailable storage", () => {
  localStorage.setItem("buzz.quick-reactions.v1:one", '{"bad":true}');
  expect(quickReactions("one", [])).toEqual(["👍", "❤️", "😂"]);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(() => recordReaction("one", "🎉")).not.toThrow();
  expect(quickReactions("one", [])).toEqual(["👍", "❤️", "😂"]);
});
