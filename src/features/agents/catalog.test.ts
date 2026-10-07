import { afterEach, expect, it } from "vitest";
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
  const catalog = createCommunityCatalog({
    reader: server.reader(as),
    viewer: as.pubkey,
    outbox: writes.outbox,
    local: writes.local,
  });
  owners.push(catalog, { dispose: () => writes.dispose() });
  return { writes, catalog: catalog.queries, owner: catalog };
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

it("refuses to publish without a writer or known content", () => {
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
    "Nothing has been shared from this coordinate.",
  );
});
