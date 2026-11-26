import { bytesToHex } from "nostr-tools/utils";
import type { Database } from "sql.js";
import {
  newTableKey,
  openTable,
  sealTable,
  TABLE_FILE,
  TABLE_KEY,
} from "../features/tables/file";
import { sqlite } from "../features/tables/sqlite";
import type { BuzzClient, BuzzEvent, RelayInfo } from "./client";

type Args = Record<string, unknown>;

const MAX_ROWS = 200;
const PAGE = 100;
const MAX_TABLES = 10_000;
/** The desktop signer refuses event content larger than this. */
const MAX_CONTENT = 64 * 1024;

export const TABLE_TOOLS = [
  {
    name: "table_create",
    description:
      "Create a private table from SQL statements (CREATE TABLE and optional INSERTs). Only you can find, read or save it. request is an id you choose for this creation: reuse it only to retry the same creation, which then finishes or returns the original table.",
    properties: {
      name: { type: "string" },
      sql: { type: "string" },
      request: { type: "string" },
    },
    required: ["name", "sql", "request"],
  },
  {
    name: "table_list",
    description: "Your tables: each one's id and name.",
    properties: {},
    required: [],
  },
  {
    name: "table_fields",
    description:
      "A table's columns, read from its SQLite schema. table is an id from table_list or table_create.",
    properties: { table: { type: "string" } },
    required: ["table"],
  },
  {
    name: "table_query",
    description: `Run one read-only SQL SELECT on a table and get at most ${MAX_ROWS} rows as JSON, with the table's version.`,
    properties: { table: { type: "string" }, sql: { type: "string" } },
    required: ["table", "sql"],
  },
  {
    name: "table_save",
    description:
      "Run SQL that changes a table (INSERT, UPDATE, DELETE, ALTER) and save it as the next version. version is the one table_query returned: when the table has changed since, nothing is saved and it returns conflict, so read the table again and retry. request is an id you choose for this change: reuse it only to retry the same change, which then returns already saved instead of applying it twice.",
    properties: {
      table: { type: "string" },
      sql: { type: "string" },
      version: { type: "string" },
      request: { type: "string" },
    },
    required: ["table", "sql"],
  },
] as const;

export const TABLE_HANDLERS: Readonly<
  Record<
    (typeof TABLE_TOOLS)[number]["name"],
    (client: BuzzClient, args: Args) => Promise<string>
  >
> = {
  async table_create(client, args) {
    const name = text(args.name);
    const sql = text(args.sql);
    const request = text(args.request);
    if (!name || !sql || !request)
      throw new Error("name, sql and request are required.");
    const keys = client.tableKeys;
    if (!keys) throw new Error("Tables are not available on this host.");
    const me = client.pubkey;
    const h = await tablesChannel(me);
    // The same request always names the same table, so a retry resumes an
    // interrupted creation, and the relay accepts only one creation of it
    // however many attempts overlap.
    const d = await uuid(`buzz.table:file:${me}:${request}`);
    const [head] = await client.query([{ artifact: "head", "#d": [d] }]);
    if (head) return alreadyCreated(client, head, h, me);

    const mine = await grantsFor(client, h, d, me);
    const key = (await recoverKey(keys, mine)) ?? newTableKey();
    const grant = mine.length ? undefined : await keyGrant(keys, h, d, me, key);
    const file = artifact(
      [
        ["d", d],
        ["h", h],
        ["type", TABLE_FILE],
        ["title", name],
        ["op", "create"],
      ],
      sealTable(key, await build(sql)),
    );
    const relay = await client.relayInfo?.();
    for (const event of grant ? [file, grant] : [file])
      fits(event, relay, "Nothing was created.");

    await ensureChannel(client, h, me);
    // The key first: a file is only published once this agent can open it,
    // so an interruption never leaves a table nobody can read.
    if (grant) await client.publish(grant);
    try {
      await client.publish(file);
    } catch (error) {
      if (!errorText(error).includes("conflict: artifact identity is taken"))
        throw error;
      const [taken] = await client.query([{ artifact: "head", "#d": [d] }]);
      if (!taken)
        throw new Error(
          `This request's table id ${d} is already used elsewhere. Use a different request.`,
        );
      return alreadyCreated(client, taken, h, me);
    }
    return `created private table ${d}`;
  },

  async table_list(client) {
    const me = client.pubkey;
    const h = await tablesChannel(me);
    const state = await channelState(client, h);
    if (!state.exists) return "[]";
    const problem = channelProblem(state, me);
    if (problem)
      throw new Error(
        `Your tables channel ${h} is not private to you (${problem}).`,
      );
    const tables: BuzzEvent[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const beyond = offset >= MAX_TABLES;
      const page = await client.query([
        {
          artifact: "current",
          "#h": [h],
          "#type": [TABLE_FILE],
          limit: beyond ? 1 : PAGE,
          offset,
        },
      ]);
      if (beyond) {
        if (page.length)
          throw new Error(
            `You have more than ${MAX_TABLES} tables; table_list cannot list them all.`,
          );
        break;
      }
      tables.push(...page.filter((table) => table.pubkey === me));
      if (page.length < PAGE) break;
    }
    return JSON.stringify(
      tables.map((table) => ({
        table: tag(table, "d"),
        name: tag(table, "title"),
      })),
    );
  },

  async table_fields(client, args) {
    return withTable(client, args, (db) => {
      const tables = db.exec(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      const fields = (tables[0]?.values ?? []).map(([name]) => ({
        table: String(name),
        columns: rows(db, `PRAGMA table_info(${quote(String(name))})`).map(
          (column) => ({
            name: column.name,
            type: column.type,
            required: column.notnull === 1,
            primaryKey: column.pk !== 0,
          }),
        ),
      }));
      return JSON.stringify(fields);
    });
  },

  async table_query(client, args) {
    const sql = text(args.sql);
    if (!sql) throw new Error("sql is required.");
    return withTable(client, args, (db, file) => {
      db.run("PRAGMA query_only = ON");
      const statement = db.prepare(sql);
      refuseAttach(statement.getSQL());
      try {
        if (!statement.getColumnNames().length)
          throw new Error("table_query runs one SELECT; nothing was changed.");
        const result = [];
        while (result.length <= MAX_ROWS && statement.step())
          result.push(statement.getAsObject());
        return JSON.stringify({
          rows: result.slice(0, MAX_ROWS),
          more: result.length > MAX_ROWS,
          version: file.id,
        });
      } finally {
        statement.free();
      }
    });
  },

  async table_save(client, args) {
    const d = text(args.table);
    const sql = text(args.sql);
    const expected = text(args.version);
    const request = text(args.request);
    if (!d || !sql) throw new Error("table and sql are required.");
    const { file, h, key, bytes } = await openTableFor(client, d);
    if (request) {
      const done = await savedFor(client, h, d, request);
      if (done) return `already saved table ${d} as version ${done.id}`;
    }
    if (expected && expected !== file.id)
      return `conflict: table ${d} is at version ${file.id}, not ${expected}. Nothing was saved; read it again and retry.`;
    const db = new (await sqlite()).Database(bytes);
    let next: Uint8Array;
    try {
      next = change(db, sql);
    } catch (error) {
      throw new Error(
        `The table's SQL failed, so nothing was saved: ${errorText(error)}`,
      );
    } finally {
      db.close();
    }
    const version = artifact(
      [
        ["d", d],
        ["h", h],
        ["type", TABLE_FILE],
        ["title", tag(file, "title") ?? "Table"],
        ["op", "update"],
        ["prev", file.id],
        ...(request ? [["request", request]] : []),
      ],
      sealTable(key, next),
    );
    fits(version, await client.relayInfo?.(), "Nothing was saved.");
    try {
      const saved = await client.publish(version);
      return `saved table ${d} as version ${saved.id}`;
    } catch (error) {
      const reason = refusal(errorText(error));
      if (!reason) throw error;
      return `${REFUSALS[reason.prefix]}: the relay said "${reason.text}"`;
    }
  },
};

/** The relay's NIP-01 reason prefixes for a refused table version. */
const REFUSALS = { "conflict:": "conflict", "restricted:": "denied" } as const;

/** The newest version of table `d`, when it is this agent's own table:
 * in its private tables channel, written by it, and opened with the key it
 * sealed to itself. The file is decrypted in memory and never written back
 * here. */
export async function openTableFor(client: BuzzClient, d: string) {
  const keys = client.tableKeys;
  if (!keys) throw new Error("Tables are not available on this host.");
  const me = client.pubkey;
  const h = await tablesChannel(me);
  const [file] = await client.query([{ artifact: "head", "#d": [d] }]);
  if (
    !file ||
    file.pubkey !== me ||
    tag(file, "type") !== TABLE_FILE ||
    tag(file, "h") !== h ||
    channelProblem(await channelState(client, h), me)
  )
    throw new Error(`You have no table ${d}.`);
  for (const grant of await grantsFor(client, h, d, me)) {
    try {
      const key = await keys.open(grant.content);
      return { file, h, key, bytes: openTable(key, file.content) };
    } catch {
      // A grant that does not open this file is skipped; another may.
    }
  }
  throw new Error(`You cannot open table ${d}.`);
}

type TableKeys = NonNullable<BuzzClient["tableKeys"]>;

const keyGrant = async (
  keys: TableKeys,
  h: string,
  d: string,
  me: string,
  key: Uint8Array,
) =>
  artifact(
    [
      ["d", crypto.randomUUID()],
      ["h", h],
      ["type", TABLE_KEY],
      ["title", "Table key"],
      ["op", "create"],
      ["for", me],
      ["table", d],
    ],
    await keys.seal(key),
  );

async function withTable(
  client: BuzzClient,
  args: Args,
  read: (db: Database, file: BuzzEvent) => string,
) {
  const d = text(args.table);
  if (!d) throw new Error("table is required.");
  const { file, bytes } = await openTableFor(client, d);
  const db = new (await sqlite()).Database(bytes);
  try {
    return read(db, file);
  } catch (error) {
    throw new Error(`The table's SQL failed: ${errorText(error)}`);
  } finally {
    db.close();
  }
}

function rows(db: Database, sql: string) {
  const [result] = db.exec(sql);
  if (!result) return [];
  return result.values.map((values) =>
    Object.fromEntries(result.columns.map((c, i) => [c, values[i]])),
  );
}

function refusal(message: string) {
  const body = message.replace(/^\d{3} /, "");
  let reason = body;
  try {
    reason = (JSON.parse(body) as { error?: string }).error ?? body;
  } catch {
    // Not JSON: the relay's message is the reason.
  }
  const prefix = (Object.keys(REFUSALS) as (keyof typeof REFUSALS)[]).find(
    (p) => reason.startsWith(p),
  );
  return prefix && { prefix, text: reason };
}

/** Applies `sql` with foreign keys enforced and returns the compacted file.
 * The check after it also catches SQL that turned enforcement off. */
function change(db: Database, sql: string) {
  db.run("PRAGMA foreign_keys = ON");
  runEach(db, sql);
  if (db.exec("PRAGMA foreign_key_check").length)
    throw new Error("A row refers to a row that does not exist.");
  db.run("VACUUM");
  return db.export();
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Runs `sql` one statement at a time, as SQLite itself splits it. */
function runEach(db: Database, sql: string) {
  for (const statement of db.iterateStatements(sql)) {
    try {
      refuseAttach(statement.getSQL());
      while (statement.step());
    } finally {
      statement.free();
    }
  }
}

/** The SQLite runtime's in-memory files outlive a call, so an attached file
 * could carry one table's rows into another call. Nothing else in this
 * build reads files, so refusing ATTACH keeps each call to its own table. */
function refuseAttach(statement: string) {
  if (/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*attach\b/i.test(statement))
    throw new Error("Tables cannot attach other databases.");
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const tag = (event: BuzzEvent | undefined, name: string) =>
  event?.tags.find((t) => t[0] === name)?.[1];

const artifact = (tags: string[][], content: string) => ({
  kind: 45010,
  content,
  tags: [["ar", "1"], ...tags],
});

async function build(sql: string) {
  const SQL = await sqlite();
  const db = new SQL.Database();
  try {
    db.run("PRAGMA page_size=512");
    return change(db, sql);
  } catch (error) {
    throw new Error(`The table's SQL failed: ${errorText(error)}`);
  } finally {
    db.close();
  }
}

/** An existing creation's result, when `head` is this agent's own table:
 * in its tables channel, which only it belongs to. */
async function alreadyCreated(
  client: BuzzClient,
  head: BuzzEvent,
  h: string,
  me: string,
) {
  const d = tag(head, "d") ?? "";
  if (
    tag(head, "type") !== TABLE_FILE ||
    tag(head, "h") !== h ||
    channelProblem(await channelState(client, h), me)
  )
    throw new Error(
      `Table ${d} exists but is not your private table. Use a different request.`,
    );
  return `already created private table ${d}`;
}

/** Creates this agent's tables channel if it does not exist yet, then
 * checks it is private with this agent as its only member. */
async function ensureChannel(client: BuzzClient, h: string, me: string) {
  if (!(await channelState(client, h)).exists)
    // Another session may be creating it too; the check below decides.
    await client
      .publish({
        kind: 9007,
        content: "",
        tags: [
          ["h", h],
          ["name", "Tables"],
          ["visibility", "private"],
          ["channel_type", "stream"],
        ],
      })
      .catch(() => undefined);
  // The relay publishes the channel's metadata and roster after creating it.
  let problem: string | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 300));
    problem = channelProblem(await channelState(client, h), me);
    if (!problem) return;
  }
  throw new Error(
    `Your tables channel ${h} is not private to you (${problem}). No table data was published.`,
  );
}

/** This agent's tables channel: a UUID-shaped digest of its key, so every
 * session finds the same one. */
const tablesChannel = (me: string) => uuid(`buzz.tables:channel:${me}`);

async function uuid(seed: string) {
  const hex = bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
    ),
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Refuses an event the relay would reject as too large, before anything
 * is published, measuring it as it will be signed and sent. */
function fits(
  event: ReturnType<typeof artifact>,
  relay: RelayInfo | undefined,
  outcome: string,
) {
  const content = new TextEncoder().encode(event.content).length;
  if (content > MAX_CONTENT)
    throw new Error(
      `This table is too large to sign: it is ${content} bytes, and the signer accepts at most ${MAX_CONTENT}. ${outcome}`,
    );
  const limit = relay?.maxMessageLength;
  if (!limit) return;
  const signed = {
    id: "0".repeat(64),
    pubkey: "0".repeat(64),
    created_at: 9_999_999_999,
    kind: event.kind,
    tags: [
      ...event.tags,
      ["ms", "999"],
      ["auth", "0".repeat(64), "", "0".repeat(128)],
    ],
    content: event.content,
    sig: "0".repeat(128),
  };
  const size = new TextEncoder().encode(
    JSON.stringify(["EVENT", signed]),
  ).length;
  if (size > limit)
    throw new Error(
      `This table is too large for this community: it is ${size} bytes to send, and the relay accepts at most ${limit}. ${outcome}`,
    );
}

/** The table key from this agent's own grant, so a resumed creation keeps
 * the key its earlier grant carries. */
async function recoverKey(keys: TableKeys, grants: readonly BuzzEvent[]) {
  for (const grant of grants) {
    try {
      return await keys.open(grant.content);
    } catch {
      // Not a key this agent sealed; another grant may be.
    }
  }
  return undefined;
}

/** The key grants this agent wrote for its table `d` in channel `h`, newest
 * first. The relay filters by table, so no page of other tables' grants
 * can hide them. */
async function grantsFor(client: BuzzClient, h: string, d: string, me: string) {
  return (
    await client.query([
      {
        kinds: [45010],
        artifact: "current",
        "#h": [h],
        "#type": [TABLE_KEY],
        "#for": [me],
        "#table": [d],
        limit: 100,
      },
    ])
  )
    .filter((grant) => grant.pubkey === me && tag(grant, "table") === d)
    .sort((a, b) => b.created_at - a.created_at);
}

/** This agent's own earlier revision of table `d` made for `request`. */
async function savedFor(
  client: BuzzClient,
  h: string,
  d: string,
  request: string,
) {
  const revisions = await client.query([
    {
      kinds: [45010],
      artifact: "history",
      "#d": [d],
      "#h": [h],
      "#request": [request],
    },
  ]);
  return revisions.find(
    (event) =>
      event.pubkey === client.pubkey && tag(event, "request") === request,
  );
}

async function channelState(client: BuzzClient, h: string) {
  const [meta, roster] = await Promise.all([
    client.query([{ kinds: [39000], "#d": [h] }]),
    client.query([{ kinds: [39002], "#d": [h] }]),
  ]);
  const newest = (events: readonly BuzzEvent[]) =>
    [...events].sort((a, b) => b.created_at - a.created_at)[0];
  const info = newest(meta);
  return {
    exists: !!info,
    private: !!info?.tags.some(([k]) => k === "private"),
    members: (newest(roster)?.tags ?? [])
      .filter((t) => t[0] === "p" && t[1])
      .map((t) => `${t[1]}:${t[3] || "member"}`)
      .sort(),
  };
}

/** Why the channel is not private with this agent as its only member and
 * owner, or `undefined` when it is. */
function channelProblem(
  state: Awaited<ReturnType<typeof channelState>>,
  me: string,
) {
  return state.private &&
    state.members.length === 1 &&
    state.members[0] === `${me}:owner`
    ? undefined
    : `private: ${state.private}; members: ${state.members.join(", ") || "unknown"}`;
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
