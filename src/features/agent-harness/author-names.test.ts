import { afterEach, expect, it, vi } from "vitest";
import type { VerifiedProfile } from "../relay/verified-profile";
import { authorName } from "../agents/reads";
import { AUTHOR_NAMES_TIMEOUT_MS, authorNames } from "./author-names";

afterEach(() => {
  vi.useRealTimers();
});

const alice = "a".repeat(64);
const bob = "b".repeat(64);

it("names a person by their verified display name, else their own profile's", () => {
  const verified = {
    displayName: "Alice S",
    username: "asmith",
  } as VerifiedProfile;
  expect(authorName({ name: "Alice S", verified }, alice)).toBe("Alice S");
  expect(authorName({ name: " Bob " }, bob)).toBe("Bob");
  // A key fragment, an empty name or one no person could have is no name.
  expect(
    authorName({ name: "npub1abc", nameIsFallback: true }, bob),
  ).toBeUndefined();
  expect(authorName({ name: " " }, bob)).toBeUndefined();
  expect(authorName({ name: "x".repeat(65) }, bob)).toBeUndefined();
  expect(authorName({ name: "Bob\u200b" }, bob)).toBeUndefined();
  expect(authorName(undefined, bob)).toBeUndefined();
});

it("gives no name the directory qualified, since it would tag someone else", () => {
  const verified = {
    displayName: "Alice S",
    username: "asmith",
  } as VerifiedProfile;
  // Two verified people share the name.
  expect(
    authorName({ name: `Alice S (${alice.slice(0, 10)})`, verified }, alice),
  ).toBeUndefined();
  // A self-declared name that imitates a verified one.
  expect(
    authorName({ name: `Alice S (${bob.slice(0, 10)})` }, bob),
  ).toBeUndefined();
});

it("reads each author's profile once before naming them", async () => {
  const profiles = vi.fn(async () => {});
  const author = vi.fn((pubkey: string) =>
    pubkey === alice ? "Alice" : undefined,
  );
  const name = await authorNames({ profiles, author }, [
    { pubkey: alice },
    { pubkey: bob },
    { pubkey: alice },
  ]);
  expect(profiles).toHaveBeenCalledExactlyOnceWith([alice, bob]);
  expect(name(alice)).toBe("Alice");
  expect(name(bob)).toBeUndefined();
});

it("starts the turn without names when profiles are slow or fail", async () => {
  vi.useFakeTimers();
  const author = () => "Alice";
  const slow = authorNames({ profiles: () => new Promise(() => {}), author }, [
    { pubkey: alice },
  ]);
  await vi.advanceTimersByTimeAsync(AUTHOR_NAMES_TIMEOUT_MS);
  expect((await slow)(alice)).toBe("Alice");
  const failed = await authorNames(
    { profiles: () => Promise.reject(new Error("offline")), author },
    [{ pubkey: alice }],
  );
  expect(failed(alice)).toBe("Alice");
  expect((await authorNames(undefined, [{ pubkey: alice }]))(alice)).toBe(
    undefined,
  );
});
