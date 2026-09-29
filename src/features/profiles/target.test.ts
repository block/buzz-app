import { expect, it } from "vitest";
import {
  profileKey,
  profileTarget,
  profileActivityViewTarget,
  profileActivityViewKey,
} from "./target";
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

it("keeps activity profile targets internal and rejects extra scope or malformed identities", () => {
  const key = "ab".repeat(32);
  const target = profileActivityViewTarget(key);
  if (!target) throw new Error("Expected a valid activity profile target");
  expect(profileActivityViewKey(target)).toBe(key);
  expect(profileActivityViewTarget(key.toUpperCase())).toBe(target);
  expect(profileKey(target)).toBeUndefined();
  expect(profileActivityViewTarget("bad")).toBeUndefined();
  for (const invalid of [
    profileTarget(key) ?? "",
    `${target}&message=abc`,
    `${target}&agent=${key}`,
    `${target}#activity`,
    target.replace("tab=activity", "tab=runtime"),
    target.replace(key, "bad"),
    target.replace("buzz:profile", "https://profile"),
  ])
    expect(profileActivityViewKey(invalid)).toBeUndefined();
});
