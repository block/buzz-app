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
/** Replaces storing and answering an accepted write; a test's hold. */
let ingest: ((event: Stored) => Promise<Response>) | undefined;
let queryFails = false;
/** Pads each answer to the 1,000 events one read takes, so it is partial. */
let capped = false;

const one = (event: Stored, name: string) =>
  event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1]);
const hex64 = (value: string | undefined) => /^[0-9a-f]{64}$/.test(value ?? "");

// The community's NIP-AE rules: ingest checks only the public envelope, and a
// read must name the caller as every author or every `p`.
beforeEach(() => {
  relay = [];
  ingest = undefined;
  queryFails = false;
  capped = false;
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
        if (ingest) return ingest(event);
        relay.push(event);
        return reply({ accepted: true });
      }
      if (queryFails) return new Response("unavailable", { status: 503 });
      const [filter] = body as [
        { authors: string[]; "#p": string[]; "#d"?: string[] },
      ];
      const own = (keys?: string[]) =>
        !!keys?.length && keys.every((key) => key === caller);
      if (!own(filter.authors) && !own(filter["#p"]))
        return new Response("restricted", { status: 403 });
      const found = relay.filter(
        (event) =>
          filter.authors.includes(event.pubkey) &&
          filter["#p"].includes(one(event, "p")[0] as string) &&
          (!filter["#d"] ||
            filter["#d"].includes(one(event, "d")[0] as string)),
      );
      return reply(
        capped && found.length
          ? Array.from({ length: 1000 }, (_, at) => found[at % found.length])
          : found,
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
    expected: /version ([0-9a-f]{16})/.exec(String(created))?.[1],
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

it("reports only what a fresh read confirms after competing writes and a lost receipt", async () => {
  await publish(
    proposeSchema(owner.secret, agent.pubkey, "goals", goals, 1_800_000_000),
    owner,
  );
  const [a, b] = [session(agent), session(agent)];
  await callTool(a, {}, "table_adopt", { table: "goals" });
  const created = String(
    await callTool(a, {}, "table_row_set", {
      table: "goals",
      row: "g1",
      values: { title: "Draft" },
    }),
  );
  const expected = /version ([0-9a-f]{16})/.exec(created)?.[1];

  // Both writers read the same version; the relay takes both writes at once.
  const held: Stored[] = [];
  let release = () => {};
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  ingest = async (event) => {
    held.push(event);
    if (held.length === 2) {
      relay.push(...held);
      release();
    }
    await both;
    return reply({ accepted: true });
  };
  const results = await Promise.allSettled([
    callTool(a, {}, "table_row_set", {
      table: "goals",
      row: "g1",
      values: { status: "active" },
      expected,
    }),
    callTool(b, {}, "table_row_set", {
      table: "goals",
      row: "g1",
      values: { title: "Renamed" },
      expected,
    }),
  ]);
  ingest = undefined;
  const head = String(
    await callTool(session(agent), {}, "table_read", {
      table: "goals",
      row: "g1",
    }),
  );
  const saved = results.flatMap((result) =>
    result.status === "fulfilled" ? [String(result.value)] : [],
  );
  const refused = results.flatMap((result) =>
    result.status === "rejected" ? [String(result.reason)] : [],
  );
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatch(/confirmed by a read just now/);
  expect(head).toContain(/version ([0-9a-f]{16})/.exec(saved[0] ?? "")?.[1]);
  expect(refused).toEqual([expect.stringMatching(/another write won/)]);

  // The relay keeps a write whose receipt is lost: one event, reported saved.
  const version = /^version: ([0-9a-f]{16})/.exec(head)?.[1];
  ingest = async (event) => {
    relay.push(event);
    throw new Error("connection reset");
  };
  const count = relay.length;
  await expect(
    callTool(a, {}, "table_row_set", {
      table: "goals",
      row: "g1",
      values: { target: "2027-04-30" },
      expected: version,
    }),
  ).resolves.toMatch(/^saved row g1; version [0-9a-f]{16}, confirmed/);
  expect(relay.length).toBe(count + 1);

  // A write that cannot be read back is neither saved nor retried.
  ingest = undefined;
  const after = /^version: ([0-9a-f]{16})/.exec(
    String(await callTool(a, {}, "table_read", { table: "goals", row: "g1" })),
  )?.[1];
  const writes = relay.length;
  queryFails = false;
  ingest = async (event) => {
    relay.push(event);
    queryFails = true;
    return reply({ accepted: true });
  };
  await expect(
    callTool(a, {}, "table_row_set", {
      table: "goals",
      row: "g1",
      values: { status: "done" },
      expected: after,
    }),
  ).rejects.toThrow(/unconfirmed/);
  expect(relay.length).toBe(writes + 1);

  // An incomplete read that holds this write proves nothing about the head.
  queryFails = false;
  const current = /^version: ([0-9a-f]{16})/.exec(
    String(await callTool(a, {}, "table_read", { table: "goals", row: "g1" })),
  )?.[1];
  ingest = async (event) => {
    relay.push(event);
    capped = true;
    return reply({ accepted: true });
  };
  await expect(
    callTool(a, {}, "table_row_set", {
      table: "goals",
      row: "g1",
      values: { status: "planned" },
      expected: current,
    }),
  ).rejects.toThrow(/unconfirmed/);
});
