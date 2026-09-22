import type { MeshSnapshot } from "../../bundled/community-compute/types";
import { newer, type RelayEvent, type ReadFilter } from "../relay/events";
import { createRelayReader, type RelayReader } from "../relay/reader";
import type { ReadTransport } from "../relay/transport";

export type ComputeStatus = Readonly<{
  state: "loading" | "ready" | "error";
  snapshot?: MeshSnapshot;
  error?: string;
}>;
export type ComputeStatusSource = {
  snapshot(): ComputeStatus;
  subscribe(listener: () => void): () => void;
  retry(): void;
};
export type ProjectSnapshot = (
  events: readonly RelayEvent[],
  authority: string,
  viewer: string,
) => Promise<MeshSnapshot>;
const PAGE_SIZE = 100;
const MAX_EVENTS = 10000;
const MAX_BYTES = 8 * 1024 * 1024;
const key = /^[0-9a-f]{64}$/;

/** Finite complete evidence, never a truncated page presented as a full mesh. */
export async function readComputeEvents(
  reader: RelayReader,
  authority: string,
  signal: AbortSignal,
): Promise<readonly RelayEvent[]> {
  if (!key.test(authority)) throw new Error("Community authority unavailable");
  const options = { signal, priority: "background" as const, fresh: true };
  const rosterEvents = await reader.read(
    [{ kinds: [13534], authors: [authority], limit: 1 }],
    options,
  );
  signal.throwIfAborted();
  const roster = rosterEvents
    .filter((event) => event.kind === 13534 && event.pubkey === authority)
    .reduce<RelayEvent | undefined>(
      (latest, event) => newer(latest, event),
      undefined,
    );
  if (!roster) throw new Error("Waiting for the current member roster");
  const members = [
    ...new Set(
      roster.tags.flatMap(([name, value]) =>
        (name === "member" || name === "p") && value && key.test(value)
          ? [value]
          : [],
      ),
    ),
  ];
  let bytes = new TextEncoder().encode(JSON.stringify(roster)).byteLength;
  if (bytes > MAX_BYTES || members.length > 20000)
    throw new Error("Community status exceeds the display limit");
  const events: RelayEvent[] = [roster];
  // Bound author filters too: a community can have more members than one query allows.
  for (let offset = 0; offset < members.length; offset += 100) {
    const authors = members.slice(offset, offset + 100);
    let filter: ReadFilter = {
      kinds: [30003],
      authors,
      "#k": ["buzz-mesh-status"],
      limit: PAGE_SIZE,
    };
    const seen = new Set<string>();
    for (;;) {
      const page = await reader.read([filter], options);
      signal.throwIfAborted();
      if (page.length > PAGE_SIZE)
        throw new Error("Invalid community status page");
      for (const event of page) {
        if (
          event.kind !== 30003 ||
          !authors.includes(event.pubkey) ||
          !event.tags.some(
            ([tag, value]) => tag === "k" && value === "buzz-mesh-status",
          ) ||
          seen.has(event.id) ||
          (filter.until !== undefined &&
            (event.created_at > filter.until ||
              (event.created_at === filter.until &&
                event.id <= (filter.before_id ?? ""))))
        )
          throw new Error("Community status pagination did not advance");
        seen.add(event.id);
        bytes += new TextEncoder().encode(JSON.stringify(event)).byteLength;
        events.push(event);
        if (events.length > MAX_EVENTS || bytes > MAX_BYTES)
          throw new Error("Community status exceeds the display limit");
      }
      if (page.length < PAGE_SIZE) break;
      // Relay composite cursor uses descending timestamp and ascending event id.
      const last = [...page]
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
        .at(-1);
      if (!last) break;
      filter = { ...filter, until: last.created_at, before_id: last.id };
    }
  }
  // A roster change during pagination cannot mix revoked members into this result.
  const check = await reader.read(
    [{ kinds: [13534], authors: [authority], limit: 1 }],
    options,
  );
  signal.throwIfAborted();
  if (
    !check.some(
      (event) =>
        event.id === roster.id &&
        event.pubkey === authority &&
        event.kind === 13534,
    )
  )
    throw new Error("Community membership changed; refresh compute status");
  return events;
}

/** Relay-generation owned, demand-driven status. Unsubscribe cancels reads;
 * session disposal also fences native projection promises that cannot be aborted. */
export function createComputeStatus(
  transport: ReadTransport,
  project: ProjectSnapshot,
) {
  const reads = createRelayReader(transport);
  let state: ComputeStatus = { state: "loading" };
  const listeners = new Set<() => void>();
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const emit = (next: ComputeStatus) => {
    state = next;
    for (const fn of listeners) fn();
  };
  const cancel = () => {
    controller?.abort();
    controller = undefined;
    clearTimeout(timer);
    clearTimeout(expiry);
  };
  const refresh = () => {
    if (disposed || controller || !listeners.size) return;
    clearTimeout(timer);
    const current = new AbortController();
    controller = current;
    void (async () => {
      try {
        const authority = transport.archiveAuthority;
        if (!authority)
          throw new Error(
            "This community has no verified membership authority",
          );
        const events = await readComputeEvents(
          reads.reader,
          authority,
          current.signal,
        );
        const snapshot = await project(events, authority, transport.viewer);
        if (current.signal.aborted || disposed) return;
        clearTimeout(expiry);
        // Expire at the earliest displayed device's deadline, even if refresh is hung.
        const oldest = Math.min(
          ...snapshot.devices.map((device) => device.reportedAt ?? 0),
        );
        if (Number.isFinite(oldest)) {
          const remaining =
            (oldest + (snapshot.freshnessSeconds ?? 120)) * 1000 - Date.now();
          if (remaining <= 0)
            throw new Error(
              "Community compute status expired; refresh to try again",
            );
          expiry = setTimeout(() => {
            emit({
              state: "error",
              error: "Community compute status expired; refresh to try again",
            });
          }, remaining);
        }
        emit({ state: "ready", snapshot });
      } catch (error) {
        if (!current.signal.aborted && !disposed) {
          clearTimeout(expiry);
          emit({
            state: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (controller === current) {
          controller = undefined;
          if (!disposed && listeners.size) timer = setTimeout(refresh, 15000);
        }
      }
    })();
  };
  const source: ComputeStatusSource = {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      refresh();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          cancel();
          state = { state: "loading" };
        }
      };
    },
    retry() {
      if (disposed || controller) return;
      emit({ state: "loading" });
      refresh();
    },
  };
  return {
    source,
    dispose() {
      disposed = true;
      cancel();
      reads.dispose();
      listeners.clear();
    },
  };
}
