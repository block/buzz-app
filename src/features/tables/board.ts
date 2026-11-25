import type { MemoryEntry } from "../agents/memory";
import {
  parseAdopted,
  parseSchema,
  proposalSlug,
  schemaSlug,
  slugTable,
  type AdoptedSchema,
  type TableSchema,
} from "./schema";

export type BoardRow = Readonly<{
  id: string;
  values: Readonly<Record<string, string | number>>;
  eventId: string;
  createdAt: number;
}>;

export type BoardTable = Readonly<{
  id: string;
  /** The agent-signed schema; absent while only proposed. */
  schema?: AdoptedSchema;
  /** The owner's latest proposal when the agent has not adopted it yet. */
  pending?: Readonly<{ schema: TableSchema; createdAt: number }>;
  /** The owner's latest proposal, so a new one is dated after it. */
  proposedAt?: number;
  rows: readonly BoardRow[];
  /** Entries under this table that could not be read. */
  unreadable: number;
}>;

/** The tables on an agent's board: agent-signed schemas and rows, with the
 * owner's proposals the agent has not adopted beside them. */
export function boardTables(
  entries: readonly MemoryEntry[],
  proposals: readonly MemoryEntry[] = [],
): readonly BoardTable[] {
  const tables = new Map<
    string,
    {
      schema?: AdoptedSchema;
      rows: BoardRow[];
      unreadable: number;
      pending?: { schema: TableSchema; createdAt: number };
      proposedAt?: number;
    }
  >();
  const table = (id: string) => {
    let found = tables.get(id);
    if (!found) {
      found = { rows: [], unreadable: 0 };
      tables.set(id, found);
    }
    return found;
  };
  for (const entry of entries) {
    const id = slugTable(entry.slug);
    if (!id || entry.slug.startsWith("mem/proposals/")) continue;
    const target = table(id);
    try {
      if (entry.slug === schemaSlug(id))
        target.schema = parseAdopted(entry.body);
      else {
        const values = (JSON.parse(entry.body) as { values?: unknown }).values;
        if (!values || typeof values !== "object")
          throw new Error("Invalid row");
        target.rows.push({
          id: entry.slug.slice(`${schemaSlug(id)}/rows/`.length),
          values: values as BoardRow["values"],
          eventId: entry.eventId,
          createdAt: entry.createdAt,
        });
      }
    } catch {
      target.unreadable++;
    }
  }
  for (const proposal of proposals) {
    const id = slugTable(proposal.slug);
    if (!id || proposal.slug !== proposalSlug(id)) continue;
    const target = table(id);
    target.proposedAt = proposal.createdAt;
    if (target.schema?.proposal.eventId === proposal.eventId) continue;
    try {
      target.pending = {
        schema: parseSchema(proposal.body),
        createdAt: proposal.createdAt,
      };
    } catch {
      target.unreadable++;
    }
  }
  return [...tables]
    .map(([id, value]) => ({
      id,
      ...value,
      rows: value.rows.sort((a, b) => b.createdAt - a.createdAt),
    }))
    .filter((value) => value.schema || value.pending || value.unreadable)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** A table id from its name: `Team goals` becomes `team-goals`. */
export function tableIdFor(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** A field key from its label: `Target date` becomes `target_date`. */
export function fieldKeyFor(label: string) {
  const key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[0-9_]+/, "");
  return key.slice(0, 64);
}
