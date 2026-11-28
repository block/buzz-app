import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { newTableKey, sealTable, TABLE_FILE } from "../features/tables/file";
import { keypair } from "../features/relay/testing";
import type { BuzzEvent } from "./client";
import { nodeClient } from "./node";
import { callTool } from "./tools";

type Key = ReturnType<typeof keypair>;
type Filter = Record<string, unknown> & {
  kinds?: number[];
  artifact?: string;
  limit?: number;
  offset?: number;
};

const owner = keypair();
const a = keypair();
const b = keypair();

/** A relay that keeps channels and artifacts in memory and applies the
 * rules the tables rely on: an artifact is readable and writable only by
 * members of its channel, a create needs an unused id, and an update must
 * name the current revision. */
function relay() {
  const relayKey = keypair();
  const channels = new Map<
    string,
    { private: boolean; roles: Map<string, string> }
  >();
  const revisions = new Map<string, BuzzEvent[]>();
  const published: BuzzEvent[] = [];
  const state = {
    published,
    info: {} as Record<string, unknown>,
    /** Stores an event and then fails its reply, as a lost acknowledgement. */
    loseReply: undefined as ((event: BuzzEvent) => boolean) | undefined,
    channel(h: string, roles: Record<string, string>, isPrivate = true) {
      channels.set(h, {
        private: isPrivate,
        roles: new Map(Object.entries(roles)),
      });
    },
    put(event: BuzzEvent) {
      const d = tag(event, "d") as string;
      revisions.set(d, [...(revisions.get(d) ?? []), event]);
    },
  };
  const member = (h: string | undefined, who: string) =>
    !!h && !!channels.get(h)?.roles.has(who);
  const head = (d: string) => revisions.get(d)?.at(-1);
  const reply = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), { status });
  function store(event: BuzzEvent) {
    published.push(event);
    const h = tag(event, "h");
    if (event.kind === 9007) {
      if (h && channels.has(h)) return reply(409, "duplicate: channel exists");
      state.channel(
        h as string,
        { [event.pubkey]: "owner" },
        !!event.tags.some(([k, v]) => k === "visibility" && v === "private"),
      );
      return undefined;
    }
    if (event.kind !== 45010) return undefined;
    if (!member(h, event.pubkey))
      return reply(403, "restricted: only members can post in this channel");
    const d = tag(event, "d") as string;
    const current = head(d);
    const prev = tag(event, "prev");
    if (!prev && current)
      return reply(409, "conflict: artifact identity is taken");
    if (prev && prev !== current?.id)
      return reply(409, "conflict: artifact head changed");
    state.put(event);
    return undefined;
  }
  function read(filter: Filter, reader: string): BuzzEvent[] {
    const d = (filter["#d"] as string[] | undefined)?.[0];
    if (filter.kinds?.[0] === 39000 || filter.kinds?.[0] === 39002) {
      const channel = d && channels.get(d);
      if (!channel) return [];
      const tags =
        filter.kinds[0] === 39000
          ? [["d", d], ...(channel.private ? [["private"]] : [])]
          : [
              ["d", d],
              ...[...channel.roles].map(([p, role]) => ["p", p, "", role]),
            ];
      return [
        finalizeEvent(
          { kind: filter.kinds[0], created_at: 1, content: "", tags },
          relayKey.secret,
        ) as unknown as BuzzEvent,
      ];
    }
    if (filter.artifact === "head") {
      const event = d && head(d);
      return event && member(tag(event, "h"), reader) ? [event] : [];
    }
    if (filter.artifact !== "current" && filter.artifact !== "history")
      return [];
    const matches = [...revisions.values()]
      .flatMap((list) =>
        filter.artifact === "history" ? list : [list.at(-1) as BuzzEvent],
      )
      .filter((event) => member(tag(event, "h"), reader))
      .filter((event) =>
        Object.entries(filter)
          .filter(([key]) => key.startsWith("#"))
          .every(([key, values]) =>
            (values as string[]).includes(tag(event, key.slice(1)) ?? ""),
          ),
      );
    const offset = filter.offset ?? 0;
    return matches.slice(offset, offset + (filter.limit ?? 100));
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.body) return new Response(JSON.stringify(state.info));
      const auth = new Headers(init.headers).get("authorization") ?? "";
      const reader = JSON.parse(
        Buffer.from(auth.replace(/^Nostr /, ""), "base64").toString(),
      ).pubkey as string;
      if (url.endsWith("/events")) {
        const event = JSON.parse(String(init.body)) as BuzzEvent;
        const refused = store(event);
        if (refused) return refused;
        if (state.loseReply?.(event)) return reply(502, "gateway timeout");
        return new Response('{"accepted":true}');
      }
      const filters = JSON.parse(String(init.body)) as Filter[];
      return new Response(
        JSON.stringify(filters.flatMap((filter) => read(filter, reader))),
      );
    }),
  );
  return state;
}

const tag = (event: Pick<BuzzEvent, "tags">, name: string) =>
  event.tags.find((t) => t[0] === name)?.[1];

const session = (key: Key) =>
  nodeClient({
    relay: "wss://relay.test",
    key: bytesToHex(key.secret),
    auth: JSON.stringify(["auth", owner.pubkey, "", "0".repeat(128)]),
    root: "/",
  });

const run = async (key: Key, name: string, args: Record<string, unknown>) =>
  String(await callTool(session(key), {}, name, args));

const create = (key: Key, request: string, sql: string, name = request) =>
  run(key, "table_create", { name, request, sql });

const query = async (key: Key, table: string, sql: string) =>
  JSON.parse(await run(key, "table_query", { table, sql })) as {
    rows: Record<string, unknown>[];
    version: string;
  };

const listed = async (key: Key) =>
  JSON.parse(await run(key, "table_list", {})) as {
    table: string;
    name: string;
  }[];

let fake: ReturnType<typeof relay>;
beforeEach(() => {
  fake = relay();
});
afterEach(() => vi.unstubAllGlobals());

it("lets a fresh session find, read and query each of its tables", async () => {
  await create(
    a,
    "goals",
    "CREATE TABLE goals(id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT); INSERT INTO goals VALUES ('g1','Ship','active'),('g2','Plan','planned')",
  );
  await create(
    a,
    "contacts",
    "CREATE TABLE contacts(email TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO contacts VALUES ('ada@example.test','Ada')",
  );
  const tables = await listed(a);
  const id = (name: string) =>
    tables.find((table) => table.name === name)?.table as string;
  expect(tables.map((table) => table.name).sort()).toEqual([
    "contacts",
    "goals",
  ]);
  expect(
    JSON.parse(await run(a, "table_fields", { table: id("goals") })),
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
      await run(a, "table_query", {
        table: id("contacts"),
        sql: "SELECT name FROM contacts",
      }),
    ).rows,
  ).toEqual([{ name: "Ada" }]);
  await expect(
    run(a, "table_query", {
      table: id("goals"),
      sql: "DELETE FROM goals RETURNING id",
    }),
  ).rejects.toThrow(/readonly/);
});

it("keeps an agent's tables from another agent, even by id", async () => {
  await create(a, "goals", "CREATE TABLE goals(title TEXT)");
  const table = (await listed(a))[0]?.table as string;
  expect(await listed(b)).toEqual([]);
  for (const [name, args] of [
    ["table_fields", { table }],
    ["table_query", { table, sql: "SELECT 1" }],
    ["table_save", { table, sql: "DELETE FROM goals" }],
  ] as const)
    await expect(run(b, name, args)).rejects.toThrow(/You have no table/);
});

it("opens only tables in the agent's own private channel", async () => {
  // A table-shaped file the agent can read in some other channel, with a
  // key it was given there.
  fake.channel("other", { [owner.pubkey]: "owner", [a.pubkey]: "member" });
  const key = newTableKey();
  fake.put(
    finalizeEvent(
      {
        kind: 45010,
        created_at: 1,
        content: sealTable(key, new Uint8Array([1])),
        tags: [
          ["d", "foreign"],
          ["h", "other"],
          ["type", TABLE_FILE],
        ],
      },
      owner.secret,
    ) as unknown as BuzzEvent,
  );
  await expect(run(a, "table_fields", { table: "foreign" })).rejects.toThrow(
    /You have no table foreign/,
  );
});

it("refuses SQL that would attach another database, so no file outlives a call", async () => {
  await create(a, "goals", "CREATE TABLE goals(title TEXT)");
  const table = (await listed(a))[0]?.table as string;
  for (const sql of [
    "ATTACH 'side.db' AS side",
    "INSERT INTO goals VALUES ('x'); /* note */ attach database 'side.db' as side",
    "-- comment\n  ATTACH ':memory:' AS side",
  ])
    await expect(run(a, "table_save", { table, sql })).rejects.toThrow(
      /cannot attach other databases/,
    );
  await expect(
    run(a, "table_query", { table, sql: "ATTACH 'side.db' AS side" }),
  ).rejects.toThrow(/cannot attach other databases/);
  await expect(
    create(a, "notes", "CREATE TABLE notes(v TEXT); ATTACH 'side.db' AS side"),
  ).rejects.toThrow(/cannot attach other databases/);
});

it("refuses to create a table when its tables channel is not private to the agent, publishing nothing", async () => {
  // Someone else made the channel this agent's tables would use first.
  const squatter = keypair();
  fake.channel(await tablesChannelOf(a), {
    [squatter.pubkey]: "owner",
    [a.pubkey]: "member",
  });
  await expect(
    create(a, "goals", "CREATE TABLE goals(title TEXT)"),
  ).rejects.toThrow(/not private to you.*No table data was published/);
  expect(fake.published).toEqual([]);
}, 10_000);

it("refuses a table larger than the relay accepts before anything is published", async () => {
  fake.info = { limitation: { max_message_length: 30_000 } };
  await expect(
    create(
      a,
      "notes",
      "CREATE TABLE notes(body TEXT); INSERT INTO notes SELECT hex(randomblob(12000))",
    ),
  ).rejects.toThrow(
    /it is \d+ bytes to send, and the relay accepts at most 30000\. Nothing was created\./,
  );
  expect(fake.published).toEqual([]);
});

async function tablesChannelOf(key: Key) {
  const hex = bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`buzz.tables:channel:${key.pubkey}`),
      ),
    ),
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

it("saves only from the version it read, and applies a retried change once", async () => {
  await create(a, "goals", "CREATE TABLE goals(title TEXT)");
  const table = (await listed(a))[0]?.table as string;
  const { version } = await query(a, table, "SELECT * FROM goals");
  expect(
    await run(a, "table_save", {
      table,
      version,
      sql: "INSERT INTO goals VALUES ('first')",
    }),
  ).toMatch(/^saved table/);
  const before = fake.published.length;
  expect(
    await run(a, "table_save", {
      table,
      version,
      sql: "INSERT INTO goals VALUES ('stale')",
    }),
  ).toMatch(/^conflict: .*Nothing was saved/);
  expect(fake.published.length).toBe(before);

  // The relay stores the change but its reply is lost, so the agent retries.
  fake.loseReply = () => true;
  const retry = {
    table,
    request: "add-second",
    sql: "INSERT INTO goals VALUES ('second')",
  };
  await expect(run(a, "table_save", retry)).rejects.toThrow();
  fake.loseReply = undefined;
  expect(await run(a, "table_save", retry)).toMatch(/^already saved table/);
  expect((await query(a, table, "SELECT title FROM goals")).rows).toEqual([
    { title: "first" },
    { title: "second" },
  ]);
});

it("reports a refusal the desktop host sends as a string", async () => {
  await create(a, "goals", "CREATE TABLE goals(title TEXT)");
  const table = (await listed(a))[0]?.table as string;
  const client = session(a);
  const publish = client.publish.bind(client);
  client.publish = async () => {
    throw "The community refused the agent event: conflict: artifact head changed";
  };
  expect(
    String(
      await callTool(client, {}, "table_save", {
        table,
        sql: "INSERT INTO goals VALUES ('x')",
      }),
    ),
  ).toBe('conflict: the relay said "conflict: artifact head changed"');
  client.publish = publish;
});

it("refuses a change that leaves a row pointing at a missing row", async () => {
  await create(
    a,
    "plans",
    "CREATE TABLE goals(id TEXT PRIMARY KEY); CREATE TABLE steps(goal TEXT REFERENCES goals(id)); INSERT INTO goals VALUES ('g1')",
  );
  const table = (await listed(a))[0]?.table as string;
  const before = fake.published.length;
  for (const sql of [
    "INSERT INTO steps VALUES ('missing')",
    "PRAGMA foreign_keys = OFF; INSERT INTO steps VALUES ('missing')",
  ])
    await expect(run(a, "table_save", { table, sql })).rejects.toThrow(
      /nothing was saved: (FOREIGN KEY constraint failed|A row refers to a row that does not exist)/,
    );
  await expect(
    create(
      a,
      "orphans",
      "CREATE TABLE goals(id TEXT PRIMARY KEY); CREATE TABLE steps(goal TEXT REFERENCES goals(id)); INSERT INTO steps VALUES ('missing')",
    ),
  ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  expect(fake.published.length).toBe(before);
});

it("refuses a table the signer cannot sign before anything is published", async () => {
  await expect(
    create(
      a,
      "notes",
      "CREATE TABLE notes(body TEXT); INSERT INTO notes SELECT hex(randomblob(18000))",
    ),
  ).rejects.toThrow(
    /it is \d+ bytes, and the signer accepts at most 65536\. Nothing was created\./,
  );
  expect(fake.published).toEqual([]);
});

it("lists every table across pages", async () => {
  await create(a, "first", "CREATE TABLE t(v TEXT)");
  const file = fake.published.find(
    (event) => event.kind === 45010 && tag(event, "type") === TABLE_FILE,
  ) as BuzzEvent;
  for (let i = 0; i < 150; i++)
    fake.put(
      finalizeEvent(
        {
          kind: 45010,
          created_at: 1,
          content: file.content,
          tags: [
            ["d", `copy-${i}`],
            ["h", tag(file, "h") as string],
            ["type", TABLE_FILE],
            ["title", `copy ${i}`],
          ],
        },
        a.secret,
      ) as unknown as BuzzEvent,
    );
  expect(await listed(a)).toHaveLength(151);
});
