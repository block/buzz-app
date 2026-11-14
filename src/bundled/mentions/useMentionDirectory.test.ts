// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { npubEncode } from "nostr-tools/nip19";
import { expect, it, vi } from "vitest";
import type { ComposerSession } from "../../features/messages/composer-session";
import type { ChannelSummary } from "../../features/relay/contracts";
import {
  fetchMentionDirectoryPage,
  useMentionDirectory,
} from "./useMentionDirectory";

it("keeps a verified person when a refined query matches only their verified full name", async () => {
  const fake = { pubkey: "a".repeat(64), name: "Fake" };
  const other = { pubkey: "b".repeat(64), name: "Fake" };
  const shared = new Map([
    [
      fake.pubkey,
      {
        name: "fname",
        verified: { displayName: "fname", fullName: "Fake Name" },
      },
    ],
  ]);
  const people = vi.fn(async () => ({
    people: [fake, other],
    hasMore: false,
  }));
  const session = {
    directMessages: { people },
    profiles: { snapshot: () => shared },
  } as unknown as ComposerSession;
  const signal = new AbortController().signal;
  await fetchMentionDirectoryPage(session, "fake", signal);
  // The complete page for "fake" answers "fake n" without another read.
  const refined = await fetchMentionDirectoryPage(session, "fake n", signal);
  expect(people).toHaveBeenCalledOnce();
  expect(refined.people).toEqual([fake]);
});

// Found by a verified name alone: the relay gave no profile name.
const unprofiled = {
  pubkey: "a".repeat(64),
  name: "a".repeat(10),
  nameIsFallback: true as const,
};

it("keeps a person with no profile on a refined query until their verified name is looked up", async () => {
  const other = { pubkey: "b".repeat(64), name: "Gabe" };
  const people = vi.fn(async () => ({
    people: [unprofiled, other],
    hasMore: false,
  }));
  const session = {
    directMessages: { people },
    profiles: { snapshot: () => new Map() },
  } as unknown as ComposerSession;
  const signal = new AbortController().signal;
  await fetchMentionDirectoryPage(session, "gab", signal);
  const refined = await fetchMentionDirectoryPage(session, "gabi", signal);
  expect(people).toHaveBeenCalledOnce();
  expect(refined.people).toEqual([unprofiled]);
});

it.each([
  ["a complete page", [{ pubkey: "b".repeat(64), name: "Ga" }]],
  ["no match", []],
])(
  "searches again past a two-character query that found %s, since the relay matches verified names only from three",
  async (_, short) => {
    const people = vi.fn(async (query: string) => ({
      people: query === "ga" ? short : [unprofiled],
      hasMore: false,
    }));
    const session = {
      directMessages: { people },
      profiles: { snapshot: () => new Map() },
    } as unknown as ComposerSession;
    const channel = { channelType: "stream" } as ChannelSummary;
    const { result, rerender } = renderHook(
      ({ query }) =>
        useMentionDirectory(session, channel, query, true, "opening"),
      { initialProps: { query: "ga" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ query: "gabi" });
    await waitFor(() => expect(result.current.people).toEqual([unprofiled]));
    expect(people.mock.calls.map(([query]) => query)).toEqual(["ga", "gabi"]);
  },
);

it("keeps a named person with no profile when a refined query matches their verified username", async () => {
  const other = { pubkey: "b".repeat(64), name: "Britt" };
  const people = vi.fn(async () => ({
    people: [unprofiled, other],
    hasMore: false,
  }));
  // Their verified name is already known.
  const shared = new Map([
    [
      unprofiled.pubkey,
      { verified: { displayName: "Brittney G", username: "brittneyg" } },
    ],
  ]);
  const session = {
    directMessages: { people },
    profiles: { snapshot: () => shared },
  } as unknown as ComposerSession;
  const signal = new AbortController().signal;
  await fetchMentionDirectoryPage(session, "brit", signal);
  const refined = await fetchMentionDirectoryPage(session, "brittneyg", signal);
  expect(people).toHaveBeenCalledOnce();
  expect(refined.people).toEqual([unprofiled]);
});

const avery = { pubkey: "a".repeat(64), name: "Avery" };
it.each([
  ["npub", npubEncode(avery.pubkey)],
  ["nostr: npub", `nostr:${npubEncode(avery.pubkey)}`],
  ["uppercase hex key", avery.pubkey.toUpperCase()],
])(
  "reads the person a pasted %s names, not a cached name-prefix page",
  async (_case, key) => {
    const people = vi.fn(async (query: string) => ({
      people: [query === key ? avery : { pubkey: "b".repeat(64), name: "B" }],
      hasMore: false,
    }));
    const session = {
      directMessages: { people },
      profiles: { snapshot: () => new Map() },
    } as unknown as ComposerSession;
    const signal = new AbortController().signal;
    await fetchMentionDirectoryPage(session, key.slice(0, 8), signal);
    // A complete page for the start of a key cannot answer its author lookup.
    expect(await fetchMentionDirectoryPage(session, key, signal)).toEqual({
      people: [avery],
      more: false,
    });
    expect(people).toHaveBeenCalledTimes(2);
  },
);
