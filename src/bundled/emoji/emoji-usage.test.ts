// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { writeView } from "../../shared/view-state";
import { exactEmoji, searchEmoji } from "./emoji-search";
import { emojiUsage, prioritizeEmoji, rememberEmoji } from "./emoji-usage";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("learns joy over job, retains exact names and uses frequency over recency", async () => {
  const custom = [{ shortcode: "job", url: "https://emoji.test/job.png" }];
  const matches = await searchEmoji("jo", custom);
  expect(matches[0]?.id).toBe("custom/job");
  rememberEmoji("alice:one", "unicode/joy");
  rememberEmoji("alice:one", "unicode/joy");
  rememberEmoji("alice:one", "custom/job");
  const usage = emojiUsage("alice:one");
  expect(prioritizeEmoji("jo", matches, usage)[0]?.id).toBe("unicode/joy");
  const exact = prioritizeEmoji("job", await searchEmoji("job", custom), usage);
  expect(exact[0]?.id).toBe("custom/job");
  expect(exactEmoji("job", exact)).toBe("custom/job");
  expect(prioritizeEmoji("jo", matches, emojiUsage("alice:two"))).toEqual(
    matches,
  );
  expect(prioritizeEmoji("jo", matches, emojiUsage("bob:one"))).toEqual(
    matches,
  );
  // Reopening/reloading reads the saved count rather than a component's cache.
  vi.resetModules();
  const reloaded = await import("./emoji-usage");
  expect(reloaded.emojiUsage("alice:one").get("unicode/joy")).toBe(2);
});

it("keeps prefix matches ahead of frequent loose matches and preserves ties", async () => {
  const matches = await searchEmoji("jo", [
    { shortcode: "job", url: "https://emoji.test/job.png" },
    { shortcode: "enjoy", url: "https://emoji.test/enjoy.png" },
  ]);
  rememberEmoji("scope", "custom/enjoy");
  const ranked = prioritizeEmoji("jo", matches, emojiUsage("scope"));
  expect(ranked.slice(0, 2).map((item) => item.id)).toEqual([
    "custom/job",
    "unicode/joy",
  ]);
  expect(new Set(ranked.map((item) => item.id))).toEqual(
    new Set(matches.map((item) => item.id)),
  );
});

it("bounds storage, validates persisted entries and tolerates unavailable storage", () => {
  writeView("scope", "emoji:usage:v1", [
    ["unicode/joy", 3],
    ["custom/job", -1],
    ["unicode/smile", "5"],
    ["unicode/wave", Number.MAX_VALUE],
    ["other/joy", 8],
    null,
  ]);
  expect([...emojiUsage("scope")]).toEqual([["unicode/joy", 3]]);
  for (let i = 0; i < 300; i++) rememberEmoji("scope", `custom/emoji${i}`);
  expect(emojiUsage("scope").size).toBe(256);
  expect(emojiUsage("scope").has("custom/emoji299")).toBe(true);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  expect(() => rememberEmoji("scope", "unicode/joy")).not.toThrow();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(emojiUsage("scope").size).toBe(0);
  expect(() => rememberEmoji("scope", "unicode/joy")).not.toThrow();
});
