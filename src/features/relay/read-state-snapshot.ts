import { eventDto, type RelayEvent } from "./events.ts";
import {
  READ_SNAPSHOT_BYTES,
  READ_SNAPSHOT_EVENTS,
} from "./read-state-host.ts";
import { record } from "./read-state-model.ts";
import { yieldToHost } from "./yield.ts";

export function readSnapshotCommunity(value: unknown): string | undefined {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.community_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value.community_id,
    )
  )
    return;
  return value.community_id;
}
export const readSnapshotFilter = (viewer: string) => [
  { kinds: [30078], authors: [viewer], read_state_snapshot: 1 },
];
export function isReadSnapshotFilter(raw: unknown, viewer: string): boolean {
  if (!Array.isArray(raw) || raw.length !== 1 || !record(raw[0])) return false;
  const filter = raw[0];
  return (
    Object.keys(filter).sort().join(",") ===
      "authors,kinds,read_state_snapshot" &&
    filter.read_state_snapshot === 1 &&
    Array.isArray(filter.kinds) &&
    filter.kinds.length === 1 &&
    filter.kinds[0] === 30078 &&
    Array.isArray(filter.authors) &&
    filter.authors.length === 1 &&
    filter.authors[0] === viewer
  );
}
/** Complete at the writer's cut only; not a CAS revision, message total or live cursor. */
export async function parseReadSnapshot(
  raw: unknown,
  viewer: string,
  communityId: string,
  signal?: AbortSignal,
): Promise<RelayEvent[]> {
  if (
    !record(raw) ||
    raw.read_state_snapshot !== 1 ||
    raw.complete !== true ||
    raw.pubkey !== viewer ||
    raw.community_id !== communityId ||
    typeof raw.snapshot_id !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.snapshot_id) ||
    !Array.isArray(raw.events) ||
    raw.events.length > READ_SNAPSHOT_EVENTS ||
    new TextEncoder().encode(JSON.stringify(raw.events)).byteLength >
      READ_SNAPSHOT_BYTES
  )
    throw new Error("Complete read-state snapshot unavailable or mismatched");
  const events: RelayEvent[] = [];
  const coordinates = new Set<string>();
  for (let i = 0; i < raw.events.length; i++) {
    signal?.throwIfAborted();
    const event = eventDto(raw.events[i]);
    if (event.pubkey !== viewer || event.kind !== 30078)
      throw new Error("Snapshot contains another principal or kind");
    // The envelope promises current events, never two versions of one address.
    const coordinate = event.tags.find(([name]) => name === "d")?.[1] ?? "";
    if (coordinates.has(coordinate))
      throw new Error("Snapshot contains duplicate coordinates");
    coordinates.add(coordinate);
    events.push(event);
    if ((i + 1) % 12 === 0) await yieldToHost();
  }
  signal?.throwIfAborted();
  return events;
}

/** Bound the encoded envelope before JSON parsing, in both browser and broker.
 * Event-array semantics retain their stricter independent 8 MiB budget. */
export async function readSnapshotText(response: Response): Promise<string> {
  if (!response.body) throw new Error("Read-state snapshot body missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > READ_SNAPSHOT_BYTES + 4096)
        throw new Error("Read-state snapshot response exceeds capacity");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
