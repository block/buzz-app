import { expect, it } from "vitest";
import { profileKey, profileTarget } from "./target";
it("round-trips only exact public identity locators", () => {
  const key = "ab".repeat(32);
  const target = profileTarget(key);
  expect(target).toMatch(/^nostr:npub1/);
  expect(profileKey(target ?? "")).toBe(key);
  expect(profileTarget(key.toUpperCase())).toBe(target);
  for (const invalid of ["", "author", "a".repeat(63), "g".repeat(64)])
    expect(profileTarget(invalid)).toBeUndefined();
  for (const invalid of [
    "nostr:nsec1abc",
    `${target}?relay=wss://evil.test`,
    `${target}/`,
    `${target}x`,
    key,
    "nostr:npub1abc",
  ])
    expect(profileKey(invalid)).toBeUndefined();
});
