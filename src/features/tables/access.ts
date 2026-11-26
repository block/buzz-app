/** The owner's side of sharing a table: its channel's roster decides who
 * may open it, and the owner's desktop gives each member the key. */
import type { SnapshotRead } from "../agents/agent-config-artifacts";
import type { RelayEvent } from "../relay/events";
import type { RelayWriter } from "../relay/transport";
import { TABLE_FILE, TABLE_KEY } from "./file";
import type { TableKeyHost } from "./host";

const ARTIFACT_KIND = 45010;
/** The most grants one reseal opens; the host refuses larger batches. */
export const RESEAL_BATCH = 16;
const PAGE = 500;
/** The relay's largest artifact page offset. */
const MAX_OFFSET = 10_000;

export type TableAccessDeps = Readonly<{
  read: SnapshotRead;
  writer: RelayWriter;
  host: TableKeyHost;
  viewer: string;
}>;

const tag = (event: RelayEvent, name: string) =>
  event.tags.find((t) => t[0] === name)?.[1];

/** Pages of the channel's current artifacts of `type`, narrowed by `tags`,
 * `size` at a time, until the relay has no more. */
async function* pages(
  deps: TableAccessDeps,
  channel: string,
  type: string,
  tags: Readonly<Record<`#${string}`, readonly string[]>>,
  size: number,
  signal: AbortSignal,
) {
  for (let offset = 0; offset <= MAX_OFFSET; offset += size) {
    const page = await deps.read(
      [
        {
          kinds: [ARTIFACT_KIND],
          "#h": [channel],
          "#type": [type],
          ...tags,
          artifact: "current",
          limit: size,
          offset,
        },
      ],
      { signal },
    );
    if (page.length) yield page;
    if (page.length < size) return;
  }
  throw new Error(
    "This table has more key grants than Buzz can search, so access could not be granted.",
  );
}

async function tablesIn(
  deps: TableAccessDeps,
  channel: string,
  signal: AbortSignal,
) {
  const tables: RelayEvent[] = [];
  for await (const page of pages(deps, channel, TABLE_FILE, {}, PAGE, signal))
    tables.push(...page);
  return tables;
}

/** Members of `channel` who cannot yet open its table: in `roster`, other
 * than the owner, with no key grant for it. Empty for a channel without a
 * table. */
export async function missingTableAccess(
  deps: TableAccessDeps,
  channel: string,
  roster: readonly string[],
  signal: AbortSignal,
) {
  const missing = new Set(roster.filter((member) => member !== deps.viewer));
  const tables = (await tablesIn(deps, channel, signal)).flatMap(
    (table) => tag(table, "d") ?? [],
  );
  if (!tables.length) return [];
  for await (const page of pages(
    deps,
    channel,
    TABLE_KEY,
    { "#table": tables },
    PAGE,
    signal,
  ))
    for (const grant of page) missing.delete(tag(grant, "for") ?? "");
  return [...missing];
}

/** Gives `member` the key to each table in `channel`, sealed by the owner's
 * host from the owner's own grants, a page at a time until one opens the
 * table's current version. The host checks `member` is in the channel. */
export async function deliverTableAccess(
  deps: TableAccessDeps,
  channel: string,
  member: string,
  signal: AbortSignal,
) {
  for (const head of await tablesIn(deps, channel, signal)) {
    const d = tag(head, "d");
    if (!d) continue;
    const content = await resealFrom(deps, channel, head, d, member, signal);
    const event = await deps.writer.sign(
      {
        kind: ARTIFACT_KIND,
        content,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["ar", "1"],
          ["d", crypto.randomUUID()],
          ["h", channel],
          ["type", TABLE_KEY],
          ["title", "Table key"],
          ["op", "create"],
          ["for", member],
          ["table", d],
        ],
      },
      signal,
    );
    await deps.writer.publish(event, signal);
  }
}

async function resealFrom(
  deps: TableAccessDeps,
  channel: string,
  head: RelayEvent,
  d: string,
  member: string,
  signal: AbortSignal,
) {
  let failure: unknown = new Error("You have no key to this table.");
  for await (const grants of pages(
    deps,
    channel,
    TABLE_KEY,
    { "#for": [deps.viewer], "#table": [d] },
    RESEAL_BATCH,
    signal,
  )) {
    try {
      return await deps.host.reseal(head, grants, member, signal);
    } catch (error) {
      signal.throwIfAborted();
      failure = error;
    }
  }
  throw failure;
}
