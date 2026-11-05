import { afterEach, expect, it, vi } from "vitest";
import type { VerifiedProfile } from "../relay/verified-profile";
import { profileNames } from "../agents/reads";
import { AUTHOR_NAMES_TIMEOUT_MS, readAuthorNames } from "./author-names";

afterEach(() => {
  vi.useRealTimers();
});

const alice = "a".repeat(64);
const bob = "b".repeat(64);

const verified = {
  displayName: "Alice S",
  username: "asmith",
} as VerifiedProfile;

it("gives a verified username and display name, and no self-declared username", () => {
  expect(profileNames({ name: "Alice S", verified }, alice)).toEqual({
    username: "asmith",
    display_name: "Alice S",
  });
  // A profile's own handle is no verified username.
  expect(profileNames({ name: " Bob ", username: "bob" }, bob)).toEqual({
    display_name: "Bob",
  });
  // A key fragment, an empty name or one no person could have is no name.
  expect(
    profileNames({ name: "npub1abc", nameIsFallback: true }, bob),
  ).toBeUndefined();
  expect(profileNames({ name: " " }, bob)).toBeUndefined();
  expect(profileNames({ name: "x".repeat(65) }, bob)).toBeUndefined();
  expect(profileNames({ name: "Bob\u200b" }, bob)).toBeUndefined();
  expect(profileNames(undefined, bob)).toBeUndefined();
});

it("gives no display name the directory qualified, since it would tag someone else", () => {
  // Two verified people share the display name: the username still names her.
  expect(
    profileNames({ name: `Alice S (${alice.slice(0, 10)})`, verified }, alice),
  ).toEqual({ username: "asmith" });
  // A self-declared name that imitates a verified one.
  expect(
    profileNames({ name: `Alice S (${bob.slice(0, 10)})` }, bob),
  ).toBeUndefined();
});

it("reads each author's profile once before naming them", async () => {
  const profiles = vi.fn(async () => {});
  const authorNames = vi.fn((pubkey: string) =>
    pubkey === alice ? { display_name: "Alice" } : undefined,
  );
  const name = await readAuthorNames({ profiles, authorNames }, [
    { pubkey: alice },
    { pubkey: bob },
    { pubkey: alice },
  ]);
  expect(profiles).toHaveBeenCalledExactlyOnceWith([alice, bob]);
  expect(name(alice)).toEqual({ display_name: "Alice" });
  expect(name(bob)).toBeUndefined();
});

it("starts the turn without names when profiles are slow or fail", async () => {
  vi.useFakeTimers();
  const authorNames = () => ({ display_name: "Alice" });
  const slow = readAuthorNames(
    { profiles: () => new Promise(() => {}), authorNames },
    [{ pubkey: alice }],
  );
  await vi.advanceTimersByTimeAsync(AUTHOR_NAMES_TIMEOUT_MS);
  expect((await slow)(alice)).toEqual({ display_name: "Alice" });
  const failed = await readAuthorNames(
    { profiles: () => Promise.reject(new Error("offline")), authorNames },
    [{ pubkey: alice }],
  );
  expect(failed(alice)).toEqual({ display_name: "Alice" });
  expect((await readAuthorNames(undefined, [{ pubkey: alice }]))(alice)).toBe(
    undefined,
  );
});
