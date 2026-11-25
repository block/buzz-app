import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bytesToHex } from "nostr-tools/utils";
import { decrypt, getConversationKey } from "nostr-tools/nip44";
import { decodeAgentMemory } from "../../browser-host/agent-memory.mjs";
import { keypair, type Key } from "../features/relay/testing";
import { proposeSchema } from "../features/tables/proposal";
import {
  parseAdopted,
  proposalSlug,
  schemaSlug,
  type TableSchema,
} from "../features/tables/schema";
import { nodeClient } from "./node";
import { callTool } from "./tools";

type Stored = {
  id: string;
  pubkey: string;
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
};

const owner = keypair();
const agent = keypair();
const stranger = keypair();
let relay: Stored[];

const one = (event: Stored, name: string) =>
  event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1]);
const hex64 = (value: string | undefined) => /^[0-9a-f]{64}$/.test(value ?? "");

// The community's NIP-AE rules: ingest checks only the public envelope, and a
// read must name the caller as every author or every `p`.
beforeEach(() => {
  relay = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const caller = JSON.parse(
        Buffer.from(
          String((init.headers as Record<string, string>).authorization).slice(
            6,
          ),
          "base64",
        ).toString(),
      ).pubkey as string;
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/events")) {
        const event = body as Stored;
        const [d, p] = [one(event, "d"), one(event, "p")];
        if (event.pubkey !== caller)
          return reply({ accepted: false, message: "auth" });
        if (d.length !== 1 || p.length !== 1 || !hex64(d[0]) || !hex64(p[0]))
          return reply({ accepted: false, message: "invalid" });
        relay.push(event);
        return reply({ accepted: true });
      }
      const [filter] = body as [
        { authors: string[]; "#p": string[]; "#d"?: string[] },
      ];
      const own = (keys?: string[]) =>
        !!keys?.length && keys.every((key) => key === caller);
      if (!own(filter.authors) && !own(filter["#p"]))
        return new Response("restricted", { status: 403 });
      return reply(
        relay.filter(
          (event) =>
            filter.authors.includes(event.pubkey) &&
            filter["#p"].includes(one(event, "p")[0] as string) &&
            (!filter["#d"] ||
              filter["#d"].includes(one(event, "d")[0] as string)),
        ),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const reply = (body: unknown) => new Response(JSON.stringify(body));
const session = (key: Key, by: Key = owner) =>
  nodeClient({
    relay: "wss://relay.test",
    key: bytesToHex(key.secret),
    auth: JSON.stringify(["auth", by.pubkey, "", "0".repeat(128)]),
    root: "/",
  });
async function publish(event: Stored, as: Key) {
  // The owner's host publishes its proposal as itself.
  const response = await fetch("https://relay.test/events", {
    method: "POST",
    headers: {
      authorization: `Nostr ${Buffer.from(JSON.stringify({ pubkey: as.pubkey })).toString("base64")}`,
    },
    body: JSON.stringify(event),
  });
  expect(await response.json()).toEqual({ accepted: true });
}

const goals: TableSchema = {
  version: 1,
  name: "Goals",
  fields: [
    { key: "title", label: "Title", type: "text", required: true },
    {
      key: "status",
      label: "Status",
      type: "select",
      options: ["planned", "active", "done"],
    },
    { key: "target", label: "Target date", type: "date" },
  ],
};

it("an agent adopts its owner's Goals proposal and only its own entries are canonical", async () => {
  await publish(
    proposeSchema(owner.secret, agent.pubkey, "goals", goals, 1_800_000_000),
    owner,
  );
  // Anyone can address a proposal to the agent; one not from its owner is ignored.
  await publish(
    proposeSchema(
      stranger.secret,
      agent.pubkey,
      "goals",
      { ...goals, name: "Spoofed" },
      1_800_000_001,
    ),
    stranger,
  );

  const buzz = session(agent);
  const [proposal, ...others] =
    (await buzz.proposals?.(proposalSlug("goals"))) ?? [];
  expect(others).toEqual([]);
  expect(proposal).toMatchObject({ author: owner.pubkey });

  // The agent discovers the table with its tools alone.
  await expect(callTool(buzz, {}, "tables_list", {})).resolves.toBe(
    'goals "Goals" proposed by your owner; adopt it with table_adopt',
  );
  await expect(
    callTool(buzz, {}, "table_row_set", { table: "goals", values: {} }),
  ).rejects.toThrow(/adopt a proposed one first/);
  await expect(
    callTool(buzz, {}, "table_adopt", { table: "goals" }),
  ).resolves.toMatch(/^adopted goals/);

  const fresh = session(agent);
  const adopted = parseAdopted(
    (await fresh.memories(schemaSlug("goals"))).entries[0]?.body ?? "",
  );
  expect(adopted.proposal).toEqual({
    author: owner.pubkey,
    eventId: proposal?.eventId,
  });
  const created = await callTool(fresh, {}, "table_row_set", {
    table: "goals",
    row: "g1",
    values: { title: "Ship synthetic demo", status: "planned" },
  });
  await expect(
    callTool(fresh, {}, "table_row_set", {
      table: "goals",
      row: "g1",
      values: { status: "active" },
    }),
  ).rejects.toThrow(/pass its version as expected/);
  await expect(
    callTool(fresh, {}, "table_row_set", {
      table: "goals",
      values: { status: "someday" },
    }),
  ).rejects.toThrow(/Title is required/);
  await callTool(fresh, {}, "table_row_set", {
    table: "goals",
    row: "g1",
    values: { status: "active", target: "2027-03-31" },
    expected: String(created).split("version ")[1],
  });
  await expect(
    callTool(session(agent), {}, "table_read", { table: "goals" }),
  ).resolves.toMatch(
    /- status \(select: planned \| active \| done\) Status[\s\S]*g1 [0-9a-f]{16} {"title":"Ship synthetic demo","status":"active","target":"2027-03-31"}/,
  );
  await expect(callTool(fresh, {}, "tables_list", {})).resolves.toBe(
    'goals "Goals" 1 rows',
  );

  // The owner decrypts the board: the agent-signed schema and row.
  const board = relay.filter((event) => event.pubkey === agent.pubkey);
  const view = await decodeAgentMemory(
    board,
    owner.secret,
    owner.pubkey,
    agent.pubkey,
    new AbortController().signal,
  );
  expect(view.entries.map((entry: { slug: string }) => entry.slug)).toEqual([
    "mem/tables/goals",
    "mem/tables/goals/rows/g1",
  ]);

  // A second identity can neither query the pair nor decrypt it.
  await expect(session(stranger).memories()).resolves.toMatchObject({
    entries: [],
  });
  await expect(
    fetch("https://relay.test/query", {
      method: "POST",
      headers: {
        authorization: `Nostr ${Buffer.from(JSON.stringify({ pubkey: stranger.pubkey })).toString("base64")}`,
      },
      body: JSON.stringify([
        { kinds: [30174], authors: [agent.pubkey], "#p": [owner.pubkey] },
      ]),
    }).then((response) => response.status),
  ).resolves.toBe(403);
  const wrongKey = getConversationKey(stranger.secret, agent.pubkey);
  for (const event of relay.filter((event) => event.pubkey !== stranger.pubkey))
    expect(() => decrypt(event.content, wrongKey)).toThrow();
});
