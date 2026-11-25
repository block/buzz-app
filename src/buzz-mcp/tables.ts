import {
  parseAdopted,
  parseSchema,
  proposalSlug,
  rowSlug,
  rowValues,
  schemaSlug,
  slugTable,
  tableId,
  type AdoptedSchema,
  type TableRow,
} from "../features/tables/schema";
import type { BuzzClient, Memory } from "./client";
import { memoryVersion } from "./memory-version";

type Args = Record<string, unknown>;

const str = { type: "string" } as const;
const table = {
  type: "string",
  description: "A table id from tables_list, such as goals.",
} as const;

export const TABLE_TOOLS = [
  {
    name: "tables_list",
    description:
      "Your tables: each adopted table's id, name and row count, and each schema your owner proposed that you have not adopted yet.",
    properties: {},
    required: [],
  },
  {
    name: "table_read",
    description:
      "A table's fields (key, type, required, options) and its rows with their versions; with row, only that row.",
    properties: { table, row: str },
    required: ["table"],
  },
  {
    name: "table_adopt",
    description:
      "Adopt the schema your owner proposed for a table, so you can keep its rows. To replace a schema you adopted before, pass its version from table_read as expected.",
    properties: { table, expected: str },
    required: ["table"],
  },
  {
    name: "table_row_set",
    description:
      "Create a row, or update one: values sets the fields you give and an empty value clears one. To update, pass row and its version from table_read as expected.",
    properties: {
      table,
      row: str,
      values: {
        type: "object",
        additionalProperties: { type: ["string", "number"] },
      },
      expected: str,
    },
    required: ["table", "values"],
  },
] as const;

export const TABLE_HANDLERS: Readonly<
  Record<
    (typeof TABLE_TOOLS)[number]["name"],
    (client: BuzzClient, args: Args) => Promise<string>
  >
> = {
  async tables_list(client) {
    const [{ entries, partial }, proposals] = await Promise.all([
      client.memories(),
      (client.proposals?.() ?? Promise.resolve([])).catch(() => undefined),
    ]);
    const adopted = new Map<string, Memory>();
    const rows = new Map<string, number>();
    for (const entry of entries) {
      const id = slugTable(entry.slug);
      if (!id) continue;
      if (entry.slug === schemaSlug(id)) adopted.set(id, entry);
      else rows.set(id, (rows.get(id) ?? 0) + 1);
    }
    const lines = [...adopted].map(([id, entry]) => {
      const schema = parseAdopted(entry.body);
      return `${id} "${schema.name}" ${rows.get(id) ?? 0} rows`;
    });
    for (const proposal of proposals ?? []) {
      const id = slugTable(proposal.slug);
      if (!id || proposal.slug !== proposalSlug(id)) continue;
      const current = adopted.get(id);
      if (
        current &&
        parseAdopted(current.body).proposal.eventId === proposal.eventId
      )
        continue;
      const name = parseSchema(proposal.body).name;
      lines.push(
        `${id} "${name}" proposed by your owner${current ? ", newer than the one you adopted" : ""}; adopt it with table_adopt`,
      );
    }
    const list = lines.join("\n") || "No tables.";
    return [
      list,
      ...(partial
        ? ["This list is incomplete: some memory could not be read."]
        : []),
      ...(proposals ? [] : ["Your owner's proposals could not be read here."]),
    ].join("\n");
  },

  async table_read(client, args) {
    const id = tableId(args.table);
    const schema = await adopted(client, id);
    const row = text(args.row);
    if (row) {
      const entry = (await client.memories(rowSlug(id, row))).entries[0];
      if (!entry) throw new Error(`No row ${row} in ${id}.`);
      return `version: ${await memoryVersion(entry.body)}\n\n${entry.body}`;
    }
    const { entries, partial } = await client.memories();
    const prefix = `${schemaSlug(id)}/rows/`;
    const rows = await Promise.all(
      entries
        .filter((entry) => entry.slug.startsWith(prefix))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(async (entry) => {
          const values = (() => {
            try {
              return JSON.stringify(parseRow(entry.body).values);
            } catch {
              return "unreadable";
            }
          })();
          return `${entry.slug.slice(prefix.length)} ${await memoryVersion(entry.body)} ${values}`;
        }),
    );
    return [
      `${id} "${schema.name}"; version ${await memoryVersion(schema.body)}`,
      ...schema.fields.map(
        (field) =>
          `- ${field.key} (${field.type}${field.required ? ", required" : ""}${field.options ? `: ${field.options.join(" | ")}` : ""}) ${field.label}`,
      ),
      rows.length ? "Rows, newest first:" : "No rows.",
      ...rows,
      ...(partial ? ["Some rows could not be read."] : []),
    ].join("\n");
  },

  async table_adopt(client, args) {
    const id = tableId(args.table);
    if (!client.proposals)
      throw new Error("Proposals cannot be read on this host.");
    const [proposal] = await client.proposals(proposalSlug(id));
    if (!proposal) throw new Error(`Your owner has not proposed ${id}.`);
    const body = JSON.stringify({
      ...parseSchema(proposal.body),
      proposal: { author: proposal.author, eventId: proposal.eventId },
    });
    const slug = schemaSlug(id);
    const { entries, deleted, partial } = await client.memories(slug);
    const current = entries[0];
    if (!current && partial)
      throw new Error(`${id} could not be read; try again.`);
    await expect(id, current, text(args.expected));
    const version = await publish(
      client,
      id,
      slug,
      body,
      current?.createdAt ?? deleted?.[0]?.createdAt ?? 0,
    );
    return `adopted ${id}; version ${version}, confirmed by a read just now`;
  },

  async table_row_set(client, args) {
    const id = tableId(args.table);
    const schema = await adopted(client, id);
    const values = args.values;
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new Error("values must be an object of field keys.");
    const row = text(args.row);
    const key = row ? tableId(row) : crypto.randomUUID();
    const slug = rowSlug(id, key);
    const { entries, deleted, partial } = row
      ? await client.memories(slug)
      : { entries: [], partial: false };
    const current = entries[0];
    if (row && !current && partial)
      throw new Error(`Row ${row} could not be read; try again.`);
    await expect(`row ${key}`, current, text(args.expected));
    const merged = {
      ...(current ? parseRow(current.body).values : {}),
      ...(values as Args),
    };
    const body = JSON.stringify({
      version: 1,
      values: rowValues(schema, merged),
    } satisfies TableRow);
    const version = await publish(
      client,
      `row ${key}`,
      slug,
      body,
      current?.createdAt ?? deleted?.[0]?.createdAt ?? 0,
    );
    return `saved row ${key}; version ${version}, confirmed by a read just now`;
  },
};

/** Writes `body` to `slug`, then reads that entry back: a concurrent write
 * may have won, and a lost receipt says nothing about whether this one
 * landed. Nothing is published twice; a later write can still replace it. */
async function publish(
  client: BuzzClient,
  what: string,
  slug: string,
  body: string,
  after: number,
) {
  const sent = await client.remember(slug, body, after).then(
    () => true,
    () => false,
  );
  const unconfirmed = `${what} is unconfirmed: the write may or may not have been saved. Read it with table_read before you retry.`;
  let head: Memory | undefined;
  try {
    const read = await client.memories(slug);
    head = read.entries.find((entry) => entry.slug === slug);
    if (!head && read.partial) throw new Error(unconfirmed);
  } catch {
    throw new Error(unconfirmed);
  }
  if (head?.body === body) return memoryVersion(body);
  if (!sent) throw new Error(unconfirmed);
  throw new Error(
    `${what} was not saved: another write won${head ? ` (version ${await memoryVersion(head.body)})` : ""}. Read it again with table_read, merge your change and retry with its version as expected.`,
  );
}

async function adopted(
  client: BuzzClient,
  id: string,
): Promise<AdoptedSchema & { body: string }> {
  const { entries, partial } = await client.memories(schemaSlug(id));
  const entry = entries[0];
  if (!entry)
    throw new Error(
      partial
        ? `${id} could not be read; try again.`
        : `No table ${id}. See tables_list; adopt a proposed one first.`,
    );
  return { ...parseAdopted(entry.body), body: entry.body };
}

async function expect(
  what: string,
  current: Memory | undefined,
  expected: string | undefined,
) {
  if (!current && expected)
    throw new Error(`No ${what} to replace; leave out expected.`);
  if (current && !expected)
    throw new Error(
      `${what} exists. Read it with table_read and pass its version as expected.`,
    );
  if (current && expected !== (await memoryVersion(current.body)))
    throw new Error(
      `${what} changed since version ${expected}. Read it again with table_read and retry.`,
    );
}

function parseRow(body: string): TableRow {
  const row = JSON.parse(body) as TableRow;
  if (row?.version !== 1 || !row.values || typeof row.values !== "object")
    throw new Error("Invalid row");
  return row;
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
