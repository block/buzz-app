/** Configurable tables kept in NIP-AE memory. A person proposes a table's
 * schema; the agent adopts it into its own memory, and only the agent signs
 * the schema and rows that are canonical. */

export const FIELD_TYPES = [
  "text",
  "number",
  "date",
  "select",
  "url",
  "person",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type TableField = Readonly<{
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: readonly string[];
}>;

export type TableSchema = Readonly<{
  version: 1;
  name: string;
  fields: readonly TableField[];
}>;

export type AdoptedSchema = TableSchema &
  Readonly<{
    /** The owner-signed proposal this schema was adopted from. */
    proposal: Readonly<{ author: string; eventId: string }>;
  }>;

export type TableRow = Readonly<{
  version: 1;
  values: Readonly<Record<string, string | number>>;
}>;

const TABLE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FIELD = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_FIELDS = 32;
const MAX_TEXT = 4000;

export function tableId(id: unknown): string {
  if (typeof id !== "string" || !TABLE.test(id))
    throw new Error(
      `Bad table ${String(id)}: use lowercase letters, digits, - or _.`,
    );
  return id;
}

export const proposalSlug = (table: string) =>
  `mem/proposals/tables/${tableId(table)}`;
export const schemaSlug = (table: string) => `mem/tables/${tableId(table)}`;
export const rowSlug = (table: string, row: string) =>
  `mem/tables/${tableId(table)}/rows/${tableId(row)}`;

/** The table a schema or row slug belongs to. */
export function slugTable(slug: string) {
  return /^mem\/(?:proposals\/)?tables\/([a-z0-9][a-z0-9_-]{0,63})(?:\/|$)/.exec(
    slug,
  )?.[1];
}

export function parseSchema(text: string): TableSchema {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object") throw new Error("Invalid schema");
  const { version, name, fields } = value as Record<string, unknown>;
  if (version !== 1) throw new Error("Unsupported schema version");
  if (typeof name !== "string" || !name.trim() || name.length > 200)
    throw new Error("A table needs a name");
  if (!Array.isArray(fields) || !fields.length || fields.length > MAX_FIELDS)
    throw new Error(`A table needs 1 to ${MAX_FIELDS} fields`);
  const keys = new Set<string>();
  return {
    version,
    name: name.trim(),
    fields: fields.map((field: unknown) => {
      const { key, label, type, required, options } = (field ?? {}) as Record<
        string,
        unknown
      >;
      if (typeof key !== "string" || !FIELD.test(key) || keys.has(key))
        throw new Error(`Bad or repeated field key ${String(key)}`);
      keys.add(key);
      if (!FIELD_TYPES.includes(type as FieldType))
        throw new Error(`Field ${key} has an unknown type`);
      if (typeof label !== "string" || !label.trim())
        throw new Error(`Field ${key} needs a label`);
      const choices =
        type === "select"
          ? Array.isArray(options) &&
            options.length &&
            options.every((option) => typeof option === "string" && option)
            ? [...new Set(options as string[])]
            : undefined
          : undefined;
      if (type === "select" && !choices)
        throw new Error(`Field ${key} needs options`);
      return {
        key,
        label: label.trim(),
        type: type as FieldType,
        ...(required === true ? { required: true } : {}),
        ...(choices ? { options: choices } : {}),
      };
    }),
  };
}

export function parseAdopted(text: string): AdoptedSchema {
  const schema = parseSchema(text);
  const { proposal } = JSON.parse(text) as {
    proposal?: Record<string, unknown>;
  };
  if (
    typeof proposal?.author !== "string" ||
    typeof proposal.eventId !== "string"
  )
    throw new Error("Schema has no proposal");
  return {
    ...schema,
    proposal: { author: proposal.author, eventId: proposal.eventId },
  };
}

/** `values` checked against `schema`: unknown keys and wrong types are
 * refused, and every required field must be present. */
export function rowValues(
  schema: TableSchema,
  values: Readonly<Record<string, unknown>>,
): TableRow["values"] {
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  const unknown = Object.keys(values).filter((key) => !fields.has(key));
  if (unknown.length) throw new Error(`Unknown fields: ${unknown.join(", ")}`);
  const out: Record<string, string | number> = {};
  for (const field of schema.fields) {
    const value = values[field.key];
    if (value === undefined || value === "") {
      if (field.required) throw new Error(`${field.label} is required`);
      continue;
    }
    out[field.key] = fieldValue(field, value);
  }
  return out;
}

function fieldValue(field: TableField, value: unknown): string | number {
  const wrong = () => new Error(`${field.label} must be ${expected(field)}`);
  if (field.type === "number") {
    const number = typeof value === "string" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number)) throw wrong();
    return number;
  }
  if (typeof value !== "string" || value.length > MAX_TEXT) throw wrong();
  if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw wrong();
  if (field.type === "select" && !field.options?.includes(value)) throw wrong();
  if (field.type === "url" && !/^(https:|buzz:)/.test(value)) throw wrong();
  if (field.type === "person" && !/^[0-9a-f]{64}$/.test(value)) throw wrong();
  return value;
}

function expected(field: TableField) {
  switch (field.type) {
    case "number":
      return "a number";
    case "date":
      return "a date like 2026-01-31";
    case "select":
      return `one of ${field.options?.join(", ")}`;
    case "url":
      return "an https: or buzz: link";
    case "person":
      return "a 64-hex pubkey";
    default:
      return `text up to ${MAX_TEXT} characters`;
  }
}
