import { finalizeEvent, getPublicKey } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import { ownerReads } from "../agents/reads";
import { guestKeys } from "../channel-members/guests";
import { PublishRejected } from "../relay/outbox";
import { matchesEvent } from "../relay/projection";
import type { RelayEvent } from "../relay/events";
import type { RelayData } from "../relay/service";
import { createRelaySession } from "../relay/session";
import { joinOffer, type UnheardAgent } from "./useGuestAgentMentions";

// "Make member and send" runs the members panel's role change against a real
// session: the roster read, the signed kind 9000, and the readback that the
// agent's own channel facts and the chooser label both follow.
const relayKey = new Uint8Array(32).fill(3);
const author = getPublicKey(relayKey);
const owner = getPublicKey(new Uint8Array(32).fill(2));
const agent = getPublicKey(new Uint8Array(32).fill(4));
const id = "11111111-1111-4111-8111-111111111111";
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function channel(
  viewerRole: string,
  { refuse = false }: { refuse?: boolean } = {},
) {
  let clock = 100;
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent({ kind, tags, content: "", created_at: clock++ }, relayKey);
  const roles = new Map([
    [owner, viewerRole],
    [agent, "guest"],
  ]);
  const roster = () =>
    record(39002, [
      ["d", id],
      ...[...roles].map(([key, role]) => ["p", key, "", role]),
    ]);
  let events: RelayEvent[] = [
    record(39000, [["d", id], ["t", "stream"], ["private"], ["name", "foo-3"]]),
    record(39001, [
      ["d", id],
      ...(viewerRole === "owner" ? [["p", owner, "owner"]] : []),
    ]),
    roster(),
  ];
  const published: RelayEvent[] = [];
  const { session, dispose } = createRelaySession({
    viewer: owner,
    relayAuthor: author,
    media: () => undefined,
    query: async (filters) =>
      events.filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      ),
    memberAdministration: {
      sign: async (template) =>
        finalizeEvent(template, new Uint8Array(32).fill(2)),
      publish: async (event) => {
        if (refuse)
          throw new PublishRejected(
            "restricted: only owners and admins can change roles",
          );
        published.push(event);
        const key = event.tags.find(([tag]) => tag === "p")?.[1] ?? "";
        const role = event.tags.find(([tag]) => tag === "role")?.[1] ?? "";
        roles.set(key, role);
        events = [...events.filter((item) => item.kind !== 39002), roster()];
      },
    },
  });
  stops.push(dispose);
  session.channels.ensureList();
  await vi.waitFor(() => expect(session.channels.list().status).toBe("ready"));
  await session.memberAdministration.refresh(id);
  const summary = session.channels.list().channels.find((c) => c.id === id);
  if (!summary) throw new Error("No channel");
  const relay = {
    snapshot: () => ({ status: "ready", session, scope: "test" }),
  } as unknown as RelayData;
  const reads = ownerReads(relay, agent);
  if (!reads) throw new Error("Owner reads unavailable");
  return { session, summary, reads, published };
}

const pollen: UnheardAgent = {
  pubkey: agent,
  name: "Pollen",
  reason: "viewing-only",
  own: true,
};

it("makes a Viewing-only agent a member, and its next turn sees it can post", async () => {
  const { session, summary, reads, published } = await channel("owner");
  expect((await reads.channel(id))?.viewingOnly).toBe(true);
  expect([...guestKeys(session.memberAdministration, id)]).toEqual([agent]);

  const join = joinOffer(session, summary, pollen);
  expect(join).toBeDefined();
  await join?.(new AbortController().signal);

  expect(published).toHaveLength(1);
  expect(published[0]?.kind).toBe(9000);
  expect(published[0]?.tags).toEqual([
    ["h", id],
    ["p", agent],
    ["role", "member"],
  ]);
  // The readback reaches the channel list the agent's turn reads, and the
  // roles the chooser label reads, with no further request.
  expect((await reads.channel(id))?.viewingOnly).toBeUndefined();
  expect(guestKeys(session.memberAdministration, id).size).toBe(0);
});

it("keeps the agent Viewing only and rejects when the relay refuses", async () => {
  const { session, summary, reads } = await channel("owner", { refuse: true });
  const join = joinOffer(session, summary, pollen);
  await expect(join?.(new AbortController().signal)).rejects.toThrow(
    /only owners and admins/,
  );
  expect((await reads.channel(id))?.viewingOnly).toBe(true);
  expect([...guestKeys(session.memberAdministration, id)]).toEqual([agent]);
});

it("publishes nothing once the send is abandoned", async () => {
  const { session, summary, reads, published } = await channel("owner");
  const abandoned = new AbortController();
  abandoned.abort();
  await expect(
    joinOffer(session, summary, pollen)?.(abandoned.signal),
  ).rejects.toThrow();
  expect(published).toEqual([]);
  expect((await reads.channel(id))?.viewingOnly).toBe(true);
});

it("offers nothing for someone else's agent, even to the channel owner", async () => {
  const { session, summary } = await channel("owner");
  expect(
    joinOffer(session, summary, { ...pollen, own: false }),
  ).toBeUndefined();
  expect(
    joinOffer(session, summary, {
      ...pollen,
      own: false,
      reason: "not-in-channel",
    }),
  ).toBeUndefined();
});

it("offers nothing to a viewer who can't change roles", async () => {
  const { session, summary } = await channel("member");
  expect(joinOffer(session, summary, pollen)).toBeUndefined();
});

it("adds an outside agent like Invite, only where the viewer may add people", async () => {
  const add = vi.fn(async () => {});
  const session = {
    viewer: owner,
    outbox: { supports: (kind: number) => kind === 9000 },
    memberAdditions: { add },
  } as unknown as Parameters<typeof joinOffer>[0];
  const outside: UnheardAgent = { ...pollen, reason: "not-in-channel" };
  const here = {
    id,
    name: "foo-3",
    channelType: "stream",
    members: [owner],
  } as never;
  await joinOffer(session, here, outside)?.(new AbortController().signal);
  expect(add).toHaveBeenCalledWith(id, agent);
  const asGuest = { ...(here as object), viewerRole: "guest" } as never;
  expect(joinOffer(session, asGuest, outside)).toBeUndefined();
});
