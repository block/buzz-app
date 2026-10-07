import { afterEach, describe, expect, it } from "vitest";
import { createOutbox } from "../relay/outbox.ts";
import { flush, keypair, signed, type Key } from "../relay/testing.ts";
import { createCommunityCatalog } from "./catalog.ts";
import { catalogRelay as relay, memoryStorage } from "./catalog-testing.ts";

const alice = keypair(),
  bob = keypair();
const agentBody = (name: string, extra: object = {}) =>
  JSON.stringify({
    display_name: name,
    system_prompt: `Be ${name}.`,
    ...extra,
  });
const teamBody = (name: string) =>
  JSON.stringify({
    v: 1,
    name,
    members: [
      { member_key: "k1", display_name: "Mate", system_prompt: "Help." },
    ],
  });

const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function client(
  server: ReturnType<typeof relay>,
  as: Key,
  storage = memoryStorage(),
) {
  const writes = createOutbox(as.pubkey, server.writer(as), storage, {
    timeoutMs: 1_000,
  });
  const base = server.reader(as);
  const link = { down: false };
  const catalog = createCommunityCatalog({
    // Mirrors the session's verified reader, which reconciles the journal.
    reader: {
      async read(...args: Parameters<typeof base.read>) {
        if (link.down) throw new Error("offline");
        const events = await base.read(...args);
        writes.observe(events);
        return events;
      },
    },
    viewer: as.pubkey,
    outbox: writes.outbox,
    local: writes.local,
  });
  owners.push(catalog, { dispose: () => writes.dispose() });
  return { writes, catalog: catalog.queries, owner: catalog, link };
}
async function settled(writes: ReturnType<typeof createOutbox>, id: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    await flush();
    const item = writes.local.snapshot().find((entry) => entry.event.id === id);
    if (item && item.delivery !== "sending") return item;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("operation did not settle");
}

it("lists only valid shared heads and lets an unshared head hide older shares", async () => {
  const server = relay();
  const at = (
    created_at: number,
    tags: string[][],
    content: string,
    kind = 30175,
  ) => signed(bob, { kind, tags, content, created_at });
  server.put(
    at(
      1,
      [
        ["d", "helper"],
        ["shared", "true"],
      ],
      agentBody("Helper"),
    ),
  );
  server.put(
    at(
      1,
      [
        ["d", "local"],
        ["shared", "true"],
      ],
      agentBody("Local", { acp_command: "/opt/x" }),
    ),
  );
  server.put(
    at(
      1,
      [
        ["d", "broken"],
        ["shared", "true"],
      ],
      "{not json",
    ),
  );
  server.put(
    at(
      1,
      [
        ["d", "crew"],
        ["shared", "true"],
      ],
      teamBody("Crew"),
      30178,
    ),
  );
  server.put(
    at(
      1,
      [
        ["d", "gone"],
        ["shared", "true"],
      ],
      agentBody("Gone"),
    ),
  );
  // Alice reads her own unshared head; the relay withholds nothing from her.
  server.put(
    signed(alice, {
      kind: 30175,
      tags: [["d", "mine"]],
      content: agentBody("Mine"),
    }),
  );
  const { catalog } = client(server, alice);
  await catalog.refresh();
  const snapshot = catalog.snapshot();
  expect(snapshot.status).toBe("ready");
  expect(
    snapshot.agents.map((entry) => entry.agent.displayName).sort(),
  ).toEqual(["Gone", "Helper"]);
  expect(snapshot.teams.map((entry) => entry.name)).toEqual(["Crew"]);
  expect(snapshot.teams[0]?.members[0]?.displayName).toBe("Mate");
  expect(catalog.state(30175, "mine")).toEqual({ shared: false });

  server.put(at(2, [["d", "gone"]], agentBody("Gone")));
  await catalog.refresh();
  expect(
    catalog.snapshot().agents.map((entry) => entry.agent.displayName),
  ).toEqual(["Helper"]);
});

it("one owner shares and unshares; another reader discovers then loses it", async () => {
  const server = relay();
  const a = client(server, alice);
  const b = client(server, bob);
  await a.writes.ready;
  await a.catalog.refresh();
  const share = a.catalog.publish(30175, "helper", true, agentBody("Helper"));
  expect(a.catalog.state(30175, "helper").change).toMatchObject({
    operation: share,
    shared: true,
    delivery: "queued",
  });
  await settled(a.writes, share);
  expect(a.catalog.state(30175, "helper")).toMatchObject({
    shared: true,
    change: { shared: true, delivery: "accepted" },
  });
  // Accepted local heads are discoverable to their owner before the relay read.
  expect(a.catalog.snapshot().agents.map((entry) => entry.owner)).toEqual([
    alice.pubkey,
  ]);
  await b.catalog.refresh();
  expect(b.catalog.snapshot().agents[0]).toMatchObject({
    owner: alice.pubkey,
    d: "helper",
    agent: { displayName: "Helper", systemPrompt: "Be Helper." },
  });

  // Same-second unshare must still supersede the share under NIP-33.
  const unshare = a.catalog.publish(30175, "helper", false);
  const removed = await settled(a.writes, unshare);
  const shared = a.writes.local
    .snapshot()
    .find((item) => item.event.id === share);
  expect(removed.event.created_at).toBeGreaterThan(
    shared?.event.created_at ?? Infinity,
  );
  expect(removed.event.content).toBe(agentBody("Helper"));
  expect(removed.event.tags.some(([name]) => name === "shared")).toBe(false);
  expect(a.catalog.state(30175, "helper")).toMatchObject({
    shared: false,
    change: { shared: false, delivery: "accepted" },
  });
  await b.catalog.refresh();
  expect(b.catalog.snapshot().agents).toEqual([]);
  await a.catalog.refresh();
  expect(a.catalog.snapshot().agents).toEqual([]);
});

it("reports a refusal, keeps it across a restart and retries it", async () => {
  const server = relay();
  const storage = memoryStorage();
  const first = client(server, alice, storage);
  await first.writes.ready;
  await first.catalog.refresh();
  server.refuse(true);
  const id = first.catalog.publish(30178, "team-1", true, teamBody("Crew"));
  await settled(first.writes, id);
  expect(first.catalog.state(30178, "team-1")).toMatchObject({
    shared: false,
    change: { operation: id, shared: true, delivery: "rejected" },
  });
  await flush();
  first.owner.dispose();

  const second = client(server, alice, storage);
  await second.writes.ready;
  expect(second.catalog.state(30178, "team-1").change).toMatchObject({
    operation: id,
    delivery: "rejected",
  });
  server.refuse(false);
  second.catalog.retry(id);
  await settled(second.writes, id);
  await second.catalog.refresh();
  expect(second.catalog.state(30178, "team-1")).toMatchObject({
    shared: true,
    change: { delivery: "accepted" },
  });
  expect(second.catalog.snapshot().teams.map((team) => team.name)).toEqual([
    "Crew",
  ]);
});

it("refuses to publish without a writer, a completed read or known content", async () => {
  const server = relay();
  const catalog = createCommunityCatalog({
    reader: server.reader(alice),
    viewer: alice.pubkey,
    outbox: undefined,
    local: undefined,
  });
  owners.push(catalog);
  expect(() => catalog.queries.publish(30175, "x", true, "{}")).toThrow(
    "This community cannot update catalog sharing.",
  );
  const { catalog: writable } = client(server, alice);
  expect(() => writable.publish(30175, "unknown", false)).toThrow(
    "The community catalog is still loading. Try again.",
  );
  await writable.refresh();
  expect(() => writable.publish(30175, "unknown", false)).toThrow(
    "Nothing has been shared from this coordinate.",
  );
});

const now = () => Math.floor(Date.now() / 1000);
const bodies = { 30175: agentBody("Helper"), 30178: teamBody("Crew") };
const listed = (catalog: ReturnType<typeof client>["catalog"]) => [
  ...catalog.snapshot().agents,
  ...catalog.snapshot().teams,
];

describe.each([30175, 30178] as const)("kind %i unsharing", (kind) => {
  const body = bodies[kind];
  const head = (created_at: number) =>
    signed(alice, {
      kind,
      tags: [
        ["d", "x"],
        ["shared", "true"],
      ],
      content: body,
      created_at,
    });

  it("supersedes a newer head from another device on a fresh journal", async () => {
    const server = relay();
    const ahead = now() + 30;
    server.put(head(ahead));
    const a = client(server, alice);
    const b = client(server, bob);
    await a.writes.ready;
    await a.catalog.refresh();
    const id = a.catalog.publish(kind, "x", false);
    const sent = await settled(a.writes, id);
    expect(sent.event.created_at).toBe(ahead + 1);
    expect(a.catalog.state(kind, "x")).toMatchObject({
      shared: false,
      change: { shared: false, delivery: "accepted" },
    });
    await b.catalog.refresh();
    expect(listed(b.catalog)).toEqual([]);
    await a.catalog.refresh();
    expect(a.catalog.state(kind, "x").shared).toBe(false);
  });

  it("breaks a same-second tie with the observed head", async () => {
    const server = relay();
    const at = now();
    server.put(head(at));
    const a = client(server, alice);
    const b = client(server, bob);
    await a.writes.ready;
    await a.catalog.refresh();
    const sent = await settled(a.writes, a.catalog.publish(kind, "x", false));
    expect(sent.event.created_at).toBeGreaterThan(at);
    await b.catalog.refresh();
    expect(listed(b.catalog)).toEqual([]);
  });

  it("orders after a dismissed share, and dismissal never revives it", async () => {
    const server = relay();
    const a = client(server, alice);
    const b = client(server, bob);
    await a.writes.ready;
    await a.catalog.refresh();
    const share = await settled(
      a.writes,
      a.catalog.publish(kind, "x", true, body),
    );
    await a.catalog.dismiss(share.event.id);
    const unshare = await settled(
      a.writes,
      a.catalog.publish(kind, "x", false),
    );
    expect(unshare.event.created_at).toBeGreaterThan(share.event.created_at);
    await a.catalog.dismiss(unshare.event.id);
    expect(a.catalog.state(kind, "x")).toEqual({ shared: false });
    expect(listed(a.catalog)).toEqual([]);
    await b.catalog.refresh();
    expect(listed(b.catalog)).toEqual([]);
  });

  it("a disconnect after dismissing an unshare never revives the share", async () => {
    const server = relay();
    const a = client(server, alice);
    await a.writes.ready;
    await a.catalog.refresh();
    await settled(a.writes, a.catalog.publish(kind, "x", true, body));
    const unshare = await settled(
      a.writes,
      a.catalog.publish(kind, "x", false),
    );
    await a.catalog.dismiss(unshare.event.id);
    a.link.down = true;
    a.owner.clear();
    expect(a.catalog.state(kind, "x").shared).toBe(false);
    expect(listed(a.catalog)).toEqual([]);
    await a.catalog.refresh().catch(() => {});
    expect(a.catalog.state(kind, "x").shared).toBe(false);
    expect(listed(a.catalog)).toEqual([]);
    a.link.down = false;
    await a.catalog.refresh();
    expect(a.catalog.state(kind, "x").shared).toBe(false);
    expect(listed(a.catalog)).toEqual([]);
  });

  it("a disconnect never revives a share another device unshared", async () => {
    const server = relay();
    const a = client(server, alice);
    await a.writes.ready;
    await a.catalog.refresh();
    const share = await settled(
      a.writes,
      a.catalog.publish(kind, "x", true, body),
    );
    server.put(
      signed(alice, {
        kind,
        tags: [["d", "x"]],
        content: "",
        created_at: share.event.created_at + 5,
      }),
    );
    await a.catalog.refresh();
    expect(a.catalog.state(kind, "x")).toEqual({ shared: false });
    a.link.down = true;
    a.owner.clear();
    expect(a.catalog.state(kind, "x")).toEqual({ shared: false });
    expect(listed(a.catalog)).toEqual([]);
    await a.catalog.refresh().catch(() => {});
    expect(a.catalog.state(kind, "x")).toEqual({ shared: false });
    expect(listed(a.catalog)).toEqual([]);
    a.link.down = false;
    await a.catalog.refresh();
    expect(a.catalog.state(kind, "x")).toEqual({ shared: false });
    expect(listed(a.catalog)).toEqual([]);
  });

  it("refuses rather than publishing an unshare the head would outrank", async () => {
    const server = relay();
    server.put(head(now() + 120));
    const a = client(server, alice);
    await a.writes.ready;
    await a.catalog.refresh();
    expect(() => a.catalog.publish(kind, "x", false)).toThrow(
      "Sharing is changing too quickly or your clock changed.",
    );
    expect(a.catalog.state(kind, "x")).toEqual({ shared: true });
  });
});

it("reconciles a restored accepted share once the relay read returns it", async () => {
  const server = relay();
  const storage = memoryStorage();
  const first = client(server, alice, storage);
  await first.writes.ready;
  await first.catalog.refresh();
  const id = first.catalog.publish(30175, "helper", true, agentBody("Helper"));
  await settled(first.writes, id);
  await flush();
  first.owner.dispose();

  const second = client(server, alice, storage);
  await second.writes.ready;
  expect(second.catalog.state(30175, "helper").change).toMatchObject({
    operation: id,
    delivery: "queued",
    stalled: true,
  });
  await second.catalog.refresh();
  expect(second.catalog.state(30175, "helper")).toMatchObject({
    shared: true,
    change: { operation: id, delivery: "accepted" },
  });
  expect(second.catalog.state(30175, "helper").change?.stalled).toBeUndefined();
});

it("re-reads a listed team and refuses a changed, unshared or missing head", async () => {
  const server = relay();
  const team = (created_at: number, shared = true, name = "Crew") =>
    signed(alice, {
      kind: 30178,
      tags: [
        ["d", "crew"],
        ...(shared ? [["shared", "true"]] : []),
      ] as string[][],
      content: teamBody(name),
      created_at,
    });
  server.put(team(10));
  const reader = client(server, bob);
  await reader.catalog.refresh();
  const [listed] = reader.catalog.snapshot().teams;
  if (!listed) throw new Error("team not listed");
  await expect(reader.catalog.currentTeam(listed)).resolves.toMatchObject({
    eventId: listed.eventId,
    name: "Crew",
  });

  server.put(team(11, true, "Crew v2"));
  await expect(reader.catalog.currentTeam(listed)).rejects.toThrow(
    "This team has changed since it was listed. Refresh and try again.",
  );

  // The owner can read its own unshared head; other readers find nothing.
  const owner = client(server, alice);
  await owner.catalog.refresh();
  const [own] = owner.catalog.snapshot().teams;
  if (!own) throw new Error("own team not listed");
  const unshared = team(12, false);
  server.put(unshared);
  await expect(
    owner.catalog.currentTeam({ ...own, eventId: unshared.id }),
  ).rejects.toThrow("This team is no longer shared to the community.");
  await expect(reader.catalog.currentTeam(listed)).rejects.toThrow(
    "This team is no longer available in the catalog.",
  );

  const missing = client(relay(), bob);
  await expect(missing.catalog.currentTeam(listed)).rejects.toThrow(
    "This team is no longer available in the catalog.",
  );
});
