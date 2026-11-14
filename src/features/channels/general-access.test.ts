import { expect, it } from "vitest";
import { openingBlocked } from "./general-access";

const viewer = "a".repeat(64);
const ownAgent = "b".repeat(64);
const inventoryAgent = "c".repeat(64);
const person = "d".repeat(64);
const othersAgent = "e".repeat(64);
const claimedAgent = "f".repeat(64);
const unloaded = "1".repeat(64);
const verified = new Map([
  [ownAgent, viewer],
  [othersAgent, person],
]);
const session = {
  viewer,
  profiles: {
    snapshot: () =>
      new Map<string, { isAgent?: true; ownerPubkey?: string }>([
        [ownAgent, { isAgent: true, ownerPubkey: viewer }],
        [othersAgent, { isAgent: true, ownerPubkey: person }],
        // An agent whose attestation is missing or does not verify.
        [claimedAgent, { isAgent: true, ownerPubkey: viewer }],
        [person, {}],
      ]),
    owner: (pubkey: string) => verified.get(pubkey),
  },
  agentChoices: {
    snapshot: () => ({
      identities: [{ pubkey: inventoryAgent }],
      complete: true,
    }),
  },
};

it.each([
  ["only the viewer", [viewer], false],
  ["the viewer and their agents", [viewer, ownAgent, inventoryAgent], false],
  ["another person", [viewer, person], true],
  ["someone else's verified agent", [viewer, othersAgent], true],
  ["an agent with unverified ownership", [viewer, claimedAgent], false],
  ["a member whose profile has not loaded", [viewer, unloaded], false],
  ["an unknown roster", undefined, false],
] as const)("%s", (_, members, blocked) => {
  expect(openingBlocked(session, members)).toBe(blocked);
});

it("blocks once a member's profile shows a person", () => {
  const loaded = new Map(session.profiles.snapshot());
  const later = {
    ...session,
    profiles: { ...session.profiles, snapshot: () => loaded },
  };
  expect(openingBlocked(later, [viewer, unloaded])).toBe(false);
  loaded.set(unloaded, {});
  expect(openingBlocked(later, [viewer, unloaded])).toBe(true);
});

it("leaves an untagged member to the relay while the inventory is incomplete", () => {
  const loading = {
    ...session,
    agentChoices: {
      snapshot: () => ({ identities: [], complete: false }),
    },
  };
  expect(openingBlocked(loading, [viewer, person])).toBe(false);
  expect(openingBlocked(loading, [viewer, othersAgent])).toBe(true);
});

it("never blocks without a viewer", () => {
  expect(openingBlocked({ ...session, viewer: undefined }, [person])).toBe(
    false,
  );
});
