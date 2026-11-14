import { finalizeEvent, getPublicKey } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import { matchesEvent } from "../relay/projection";
import type { RelayData } from "../relay/service";
import { createRelaySession } from "../relay/session";
import { ownerReads } from "./reads";

// The desktop app reads an agent's channels through its owner's session, so
// the session's own role there is the owner's, not the agent's.
const relayKey = new Uint8Array(32).fill(3);
const author = getPublicKey(relayKey);
const owner = getPublicKey(new Uint8Array(32).fill(2));
const agent = getPublicKey(new Uint8Array(32).fill(4));
const id = "11111111-1111-4111-8111-111111111111";
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function reads(ownerRole: string, agentRole: string) {
  let clock = 100;
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent({ kind, tags, content: "", created_at: clock++ }, relayKey);
  const roster = (role: string) =>
    record(39002, [
      ["d", id],
      ["p", owner, "", ownerRole],
      ["p", agent, "", role],
    ]);
  let events = [
    record(39000, [["d", id], ["t", "stream"], ["private"], ["name", "foo-3"]]),
    record(39001, [
      ["d", id],
      ...(ownerRole === "owner" ? [["p", owner, "owner"]] : []),
    ]),
    roster(agentRole),
  ];
  const sessionOwner = createRelaySession({
    viewer: owner,
    relayAuthor: author,
    media: () => undefined,
    query: async (filters) =>
      events.filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      ),
  });
  stops.push(sessionOwner.dispose);
  const { session } = sessionOwner;
  session.channels.ensureList();
  await vi.waitFor(() => expect(session.channels.list().status).toBe("ready"));
  const relay = {
    snapshot: () => ({ status: "ready", session, scope: "test" }),
  } as unknown as RelayData;
  const source = ownerReads(relay, agent);
  if (!source) throw new Error("Owner reads unavailable");
  return Object.assign(Object.create(source) as typeof source, {
    /** The relay's roster now gives the agent `role`, and the owner rereads it. */
    async change(role: string) {
      events = [
        ...events.filter((event) => event.kind !== 39002),
        roster(role),
      ];
      await session.memberAdministration.refresh(id);
    },
  });
}

it("marks a channel viewing-only by the agent's role, not the owner's", async () => {
  const facts = await (await reads("owner", "guest")).channel(id);
  expect(facts?.viewingOnly).toBe(true);
});

it("doesn't mark the agent viewing-only when only its owner is a guest", async () => {
  const facts = await (await reads("guest", "member")).channel(id);
  expect(facts).toBeDefined();
  expect(facts?.viewingOnly).toBeUndefined();
});

it("follows a role change that keeps the agent in the channel", async () => {
  const source = await reads("owner", "guest");
  expect((await source.channel(id))?.viewingOnly).toBe(true);
  // Guest to member: the same members, so only the roles tell them apart.
  await source.change("bot");
  expect((await source.channel(id))?.viewingOnly).toBeUndefined();
});
