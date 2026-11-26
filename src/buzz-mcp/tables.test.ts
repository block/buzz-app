import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import initSqlJs from "sql.js";
import {
  newTableKey,
  sealTable,
  TABLE_FILE,
  TABLE_KEY,
  wrapKey,
} from "../features/tables/file";
import { keypair } from "../features/relay/testing";
import { nodeClient } from "./node";
import { callTool } from "./tools";

const owner = keypair();
const agent = keypair();
let published: unknown[];
let relayInfo: unknown;

beforeEach(() => {
  published = [];
  relayInfo = { supported_extensions: ["nip-ar"] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/events")) {
        published.push(JSON.parse(String(init?.body)));
        return new Response('{"accepted":true}');
      }
      if (!init?.body) return new Response(JSON.stringify(relayInfo));
      return new Response("[]");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

it("refuses to create a table when its tables channel is not private to the agent, publishing nothing", async () => {
  const squatter = keypair();
  const channel = (filter: { kinds?: number[]; "#d"?: string[] }) => {
    const d = filter["#d"]?.[0] ?? "";
    if (filter.kinds?.[0] === 39000)
      return finalizeEvent(
        {
          kind: 39000,
          created_at: 1,
          content: "",
          tags: [["d", d], ["private"]],
        },
        squatter.secret,
      );
    return finalizeEvent(
      {
        kind: 39002,
        created_at: 1,
        content: "",
        tags: [
          ["d", d],
          ["p", squatter.pubkey, "", "owner"],
          ["p", agent.pubkey, "", "member"],
        ],
      },
      squatter.secret,
    );
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/events")) {
        published.push(JSON.parse(String(init?.body)));
        return new Response('{"accepted":true}');
      }
      if (!init?.body) return new Response(JSON.stringify(relayInfo));
      const [filter] = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify(filter?.kinds?.[0] >= 39000 ? [channel(filter)] : []),
      );
    }),
  );
  const buzz = nodeClient({
    relay: "wss://relay.test",
    key: bytesToHex(agent.secret),
    auth: JSON.stringify(["auth", owner.pubkey, "", "0".repeat(128)]),
    root: "/",
  });
  await expect(
    callTool(buzz, {}, "table_create", {
      name: "Goals",
      sql: "CREATE TABLE goals(title TEXT NOT NULL, status TEXT)",
      request: "goals-1",
    }),
  ).rejects.toThrow(/not private to you.*No table data was published/);
  expect(published).toEqual([]);
}, 10_000);

it("refuses a table larger than the relay accepts before creating its channel", async () => {
  relayInfo = { limitation: { max_message_length: 30_000 } };
  const buzz = nodeClient({
    relay: "wss://relay.test",
    key: bytesToHex(agent.secret),
    auth: JSON.stringify(["auth", owner.pubkey, "", "0".repeat(128)]),
    root: "/",
  });
  await expect(
    callTool(buzz, {}, "table_create", {
      name: "Notes",
      sql: "CREATE TABLE notes(body TEXT); INSERT INTO notes SELECT hex(randomblob(12000))",
      request: "notes-1",
    }),
  ).rejects.toThrow(
    /it is \d+ bytes to send, and the relay accepts at most 30000\. Nothing was created\./,
  );
  expect(published).toEqual([]);
});

it("discovers a table's fields, answers read-only queries and reports refused saves", async () => {
  let refusal = "";
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(
    "CREATE TABLE goals(id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT); INSERT INTO goals VALUES ('g1','Ship','active'),('g2','Plan','planned')",
  );
  const key = newTableKey();
  const file = finalizeEvent(
    {
      kind: 45010,
      created_at: 1,
      content: sealTable(key, db.export()),
      tags: [
        ["d", "goals"],
        ["h", "channel"],
        ["type", TABLE_FILE],
      ],
    },
    owner.secret,
  );
  const grant = finalizeEvent(
    {
      kind: 45010,
      created_at: 1,
      content: wrapKey(agent.secret, agent.pubkey, key),
      tags: [
        ["h", "channel"],
        ["type", TABLE_KEY],
        ["for", agent.pubkey],
        ["table", "goals"],
      ],
    },
    agent.secret,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.body) return new Response(JSON.stringify(relayInfo));
      if (url.endsWith("/events")) {
        const event = JSON.parse(String(init?.body));
        expect(event.tags).toContainEqual(["prev", file.id]);
        return new Response(JSON.stringify({ error: refusal }), {
          status: refusal.startsWith("conflict") ? 409 : 403,
        });
      }
      const [filter] = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify(filter.artifact === "head" ? [file] : [grant]),
      );
    }),
  );
  const buzz = nodeClient({
    relay: "wss://relay.test",
    key: bytesToHex(agent.secret),
    root: "/",
  });

  expect(
    JSON.parse(
      String(await callTool(buzz, {}, "table_fields", { table: "goals" })),
    ),
  ).toEqual([
    {
      table: "goals",
      columns: [
        { name: "id", type: "TEXT", required: false, primaryKey: true },
        { name: "title", type: "TEXT", required: true, primaryKey: false },
        { name: "status", type: "TEXT", required: false, primaryKey: false },
      ],
    },
  ]);
  expect(
    JSON.parse(
      String(
        await callTool(buzz, {}, "table_query", {
          table: "goals",
          sql: "SELECT title FROM goals WHERE status = 'active'",
        }),
      ),
    ),
  ).toEqual({ rows: [{ title: "Ship" }], more: false });
  await expect(
    callTool(buzz, {}, "table_query", {
      table: "goals",
      sql: "DELETE FROM goals RETURNING id",
    }),
  ).rejects.toThrow(/readonly/);

  const save = () =>
    callTool(buzz, {}, "table_save", {
      table: "goals",
      sql: "UPDATE goals SET status = 'done'",
    });
  refusal = "conflict: artifact head changed";
  expect(await save()).toBe(
    'conflict: the relay said "conflict: artifact head changed"',
  );
  refusal = "restricted: only members can post in this channel";
  expect(await save()).toBe(
    'denied: the relay said "restricted: only members can post in this channel"',
  );
});
