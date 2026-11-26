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
import type { BuzzClient, BuzzEvent, RelayInfo, Template } from "./client";

type Args = Record<string, unknown>;

/** The relay feature a table channel needs: only owners and admins add
 * members, so a writer cannot widen who the table is shared with. */
export const ADD_ROLE_EXTENSION = "buzz-channel-add-role";

const MAX_ROWS = 200;

export const TABLE_TOOLS = [
  {
    name: "table_create",
    description:
      "Create a private table from SQL statements (CREATE TABLE and optional INSERTs). Your owner owns it and controls who it is shared with; you can save it. request is an id you choose for this creation: reuse it only to retry the same creation, which then finishes or returns the original table.",
    properties: {
      name: { type: "string" },
      sql: { type: "string" },
      request: { type: "string" },
    },
    required: ["name", "sql", "request"],
  },
  {
    name: "table_fields",
    description:
      "A table's columns, read from its SQLite schema. table is the id table_create returned.",
    properties: { table: { type: "string" } },
    required: ["table"],
  },
  {
    name: "table_query",
    description: `Run one read-only SQL SELECT on a table and get at most ${MAX_ROWS} rows as JSON.`,
    properties: { table: { type: "string" }, sql: { type: "string" } },
    required: ["table", "sql"],
  },
  {
    name: "table_save",
    description:
      "Run SQL that changes a table (INSERT, UPDATE, DELETE, ALTER) and save it as the next version. Returns saved, conflict when someone saved first (read again and retry), or denied when you may only read it.",
    properties: { table: { type: "string" }, sql: { type: "string" } },
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
    const owner = client.owner;
    if (!owner)
      throw new Error(
        "Tables need your owner, and this host does not know them.",
      );
    const keys = client.tableKeys;
    if (!keys || !client.relayInfo)
      throw new Error("Tables are not available on this host.");
    // Before anything is published: a relay that cannot restrict additions
    // would let a writer share the table on.
    const relay = await client.relayInfo();
    if (!relay.extensions.includes(ADD_ROLE_EXTENSION))
      throw new Error(
        "This community's relay cannot restrict who adds members to a channel, so a table here would not stay under your owner's control. Nothing was created.",
      );
    const me = client.pubkey;
    // The same request always names the same channel and table, so a retry
    // resumes an interrupted creation, and the relay accepts only one
    // creation of the table however many attempts overlap.
    const { h, d } = await creationIds(me, owner, request);
    const [head] = await client.query([{ artifact: "head", "#d": [d] }]);
    if (head) return alreadyCreated(client, head, h, owner);

    const mine = (await grantsFor(client, h, d)).filter(
      (grant) => grant.pubkey === me,
    );
    const key = (await recoverKey(keys, me, mine)) ?? newTableKey();
    const grants = await Promise.all(
      [owner, me]
        .filter((member) => !mine.some((g) => tag(g, "for") === member))
        .map((member) => keyGrant(keys, h, d, member, key)),
    );
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
    for (const event of [file, ...grants])
      fits(event, relay, "Nothing was created.");

    await setUpChannel(client, h, name, owner, me);
    // Keys first: a file is only published once its owner can open it, so
    // an interruption never leaves a table that nobody can read.
    for (const grant of grants) await client.publish(grant);
    try {
      await client.publish(file);
    } catch (error) {
      if (
        !(error as Error).message.includes(
          "conflict: artifact identity is taken",
        )
      )
        throw error;
      const [taken] = await client.query([{ artifact: "head", "#d": [d] }]);
      if (!taken)
        throw new Error(
          `This request's table id ${d} is already used outside your table's channel. Use a different request.`,
        );
      return alreadyCreated(client, taken, h, owner);
    }
    return `created ${described(d, h)}`;
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
    return withTable(client, args, (db) => {
      db.run("PRAGMA query_only = ON");
      const statement = db.prepare(sql);
      try {
        if (!statement.getColumnNames().length)
          throw new Error("table_query runs one SELECT; nothing was changed.");
        const result = [];
        while (result.length <= MAX_ROWS && statement.step())
          result.push(statement.getAsObject());
        return JSON.stringify({
          rows: result.slice(0, MAX_ROWS),
          more: result.length > MAX_ROWS,
        });
      } finally {
        statement.free();
      }
    });
  },

  async table_save(client, args) {
    const d = text(args.table);
    const sql = text(args.sql);
    if (!d || !sql) throw new Error("table and sql are required.");
    const { file, h, key, bytes } = await openTableFor(client, d);
    const db = new (await sqlite()).Database(bytes);
    let next: Uint8Array;
    try {
      db.run(sql);
      db.run("VACUUM");
      next = db.export();
    } catch (error) {
      throw new Error(
        `The table's SQL failed, so nothing was saved: ${(error as Error).message}`,
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
      ],
      sealTable(key, next),
    );
    if (client.relayInfo)
      fits(version, await client.relayInfo(), "Nothing was saved.");
    try {
      const saved = await client.publish(version);
      return `saved table ${d} as version ${saved.id}`;
    } catch (error) {
      const reason = refusal((error as Error).message);
      if (!reason) throw error;
      return `${REFUSALS[reason.prefix]}: the relay said "${reason.text}"`;
    }
  },
};

/** The relay's NIP-01 reason prefixes for a refused table version. */
const REFUSALS = { "conflict:": "conflict", "restricted:": "denied" } as const;

/** The newest version of table `d`, opened with the key granted to this
 * agent. The file is decrypted in memory and never written back here. */
export async function openTableFor(client: BuzzClient, d: string) {
  if (!client.tableKeys)
    throw new Error("Tables are not available on this host.");
  const [file] = await client.query([{ artifact: "head", "#d": [d] }]);
  const h = tag(file, "h");
  if (!file || tag(file, "type") !== TABLE_FILE || !h)
    throw new Error(`No table ${d} is shared with you.`);
  const grants = await grantsFor(client, h, d, client.pubkey);
  for (const grant of grants) {
    try {
      const key = await client.tableKeys.unwrap(grant.pubkey, grant.content);
      return { file, h, key, bytes: openTable(key, file.content) };
    } catch {
      // A grant that does not open this file is skipped; another may.
    }
  }
  throw new Error(`Table ${d} has not been shared with you.`);
}

/** Shares table `d` with `member` as a writer or a reader. Only the table
 * channel's owner can add them; the key is granted once they are in. */
export async function grantTable(
  client: BuzzClient,
  d: string,
  member: string,
  role: "member" | "guest",
) {
  const keys = client.tableKeys;
  if (!keys) throw new Error("Tables are not available on this host.");
  const { h, key } = await openTableFor(client, d);
  await client.publish({
    kind: 9000,
    content: "",
    tags: [
      ["h", h],
      ["p", member],
      ["role", role],
    ],
  });
  await client.publish(await keyGrant(keys, h, d, member, key));
}

type TableKeys = NonNullable<BuzzClient["tableKeys"]>;

const keyGrant = async (
  keys: TableKeys,
  h: string,
  d: string,
  member: string,
  key: Uint8Array,
) =>
  artifact(
    [
      ["d", crypto.randomUUID()],
      ["h", h],
      ["type", TABLE_KEY],
      ["title", "Table key"],
      ["op", "create"],
      ["for", member],
      ["table", d],
    ],
    await keys.wrap(member, key),
  );

async function withTable(
  client: BuzzClient,
  args: Args,
  read: (db: Database) => string,
) {
  const d = text(args.table);
  if (!d) throw new Error("table is required.");
  const { bytes } = await openTableFor(client, d);
  const db = new (await sqlite()).Database(bytes);
  try {
    return read(db);
  } catch (error) {
    throw new Error(`The table's SQL failed: ${(error as Error).message}`);
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
    db.run(sql);
    db.run("VACUUM");
    return db.export();
  } catch (error) {
    throw new Error(`The table's SQL failed: ${(error as Error).message}`);
  } finally {
    db.close();
  }
}

const described = (d: string, h: string) =>
  `table ${d} in private channel ${h}; your owner owns it and you can save it`;

/** An existing creation's result, when `head` is its own table: in its
 * channel, which is restricted and owned by the owner. */
async function alreadyCreated(
  client: BuzzClient,
  head: BuzzEvent,
  h: string,
  owner: string,
) {
  const state = await channelState(client, h);
  const d = tag(head, "d") ?? "";
  if (
    tag(head, "type") !== TABLE_FILE ||
    tag(head, "h") !== h ||
    !state.restricted ||
    state.roles.get(owner) !== "owner"
  )
    throw new Error(
      `Table ${d} exists but is not this request's table under your owner's control. Use a different request.`,
    );
  return `already created ${described(d, h)}`;
}

/** Creates the table channel restricted to owner additions, with the owner
 * as its owner and this agent as a writer, doing only the steps an earlier
 * interrupted attempt left undone. */
async function setUpChannel(
  client: BuzzClient,
  h: string,
  name: string,
  owner: string,
  me: string,
) {
  let state = await channelState(client, h);
  // Another attempt at this creation may be making the same changes; any
  // step it already made is refused, and the roster check below decides.
  const step = (event: Template) =>
    client.publish(event).catch(() => undefined);
  if (!state.exists)
    await step({
      kind: 9007,
      content: "",
      tags: [
        ["h", h],
        ["name", name],
        ["visibility", "private"],
        ["channel_type", "stream"],
        ["p", owner],
      ],
    });
  if (!state.restricted)
    await step({
      kind: 9002,
      content: "",
      tags: [
        ["h", h],
        ["add_role", "admin"],
      ],
    });
  if (state.roles.get(owner) !== "owner") await step(role(h, owner, "owner"));
  if (state.roles.get(me) !== "member") await step(role(h, me, "member"));
  // The relay republishes the channel's metadata and roster after each
  // change, so wait briefly for them to reflect all of it.
  let problem: string | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 300));
    state = await channelState(client, h);
    problem = channelProblem(state, owner, me);
    if (!problem) return;
  }
  throw new Error(
    `The table channel ${h} is not set up as expected (${problem}). No table data was published.`,
  );
}

const role = (h: string, member: string, name: string) => ({
  kind: 9000,
  content: "",
  tags: [
    ["h", h],
    ["p", member],
    ["role", name],
  ],
});

/** Stable ids for this agent's creation `request`: UUID-shaped digests, so
 * the relay sees ordinary channel and artifact ids. */
async function creationIds(me: string, owner: string, request: string) {
  const id = async (part: string) => {
    const hex = bytesToHex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            `buzz.table:${part}:${me}:${owner}:${request}`,
          ),
        ),
      ),
    );
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  return { h: await id("channel"), d: await id("file") };
}

/** Refuses an event the relay would reject as too large, before anything
 * is published, measuring it as it will be signed and sent. */
function fits(
  event: ReturnType<typeof artifact>,
  relay: RelayInfo,
  outcome: string,
) {
  const limit = relay.maxMessageLength;
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

/** The table key from a grant this agent wrote, so a resumed creation keeps
 * the key its earlier grants carry. */
async function recoverKey(
  keys: TableKeys,
  me: string,
  grants: readonly BuzzEvent[],
) {
  for (const grant of grants) {
    const peer = grant.pubkey === me ? tag(grant, "for") : grant.pubkey;
    if (!peer) continue;
    try {
      return await keys.unwrap(peer, grant.content);
    } catch {
      // Not a key this agent can open; another grant may be.
    }
  }
  return undefined;
}

/** Table key grants in channel `h`, newest first: for table `d` and to
 * `member` when given. */
async function grantsFor(
  client: BuzzClient,
  h: string,
  d?: string,
  member?: string,
) {
  return (
    await client.query([
      {
        artifact: "current",
        "#h": [h],
        "#type": [TABLE_KEY],
        ...(member && { "#for": [member] }),
      },
    ])
  )
    .filter((grant) => d === undefined || tag(grant, "table") === d)
    .sort((a, b) => b.created_at - a.created_at);
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
    restricted: !!info?.tags.some(
      ([k, v]) => k === "add_role" && v === "admin",
    ),
    roles: new Map(
      (newest(roster)?.tags ?? [])
        .filter((t) => t[0] === "p" && t[1])
        .map((t) => [t[1] as string, t[3] || "member"]),
    ),
  };
}

/** Why the channel is not restricted with exactly the owner as owner and
 * this agent as a writer, or `undefined` when it is. */
function channelProblem(
  state: Awaited<ReturnType<typeof channelState>>,
  owner: string,
  me: string,
) {
  const members = [...state.roles].map(([p, r]) => `${p}:${r}`).sort();
  const expected = [`${owner}:owner`, `${me}:member`].sort();
  return state.restricted &&
    JSON.stringify(members) === JSON.stringify(expected)
    ? undefined
    : `restricted: ${state.restricted}; members: ${members.join(", ") || "unknown"}`;
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
