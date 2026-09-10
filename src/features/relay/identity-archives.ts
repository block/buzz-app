import { byteSize } from "./budget";
import type { RelayEvent } from "./events";
import type { RelayReader } from "./reader";

export type IdentityArchiveSnapshot = Readonly<{
  status: "unavailable" | "idle" | "loading" | "ready" | "error";
  archived: readonly string[];
  eventId?: string;
  createdAt?: number;
  readAt?: number;
  error?: string;
}>;
const empty: readonly string[] = Object.freeze([]);
const HEX = /^[0-9a-f]{64}$/;
const MAX_BYTES = 2 * 1024 * 1024;

/** Relay-scoped NIP-IA visibility, never access, membership or liveness evidence.
 * The caller supplies only explicit NIP-11 self, never the contact-key fallback.
 * Reads are lazy finite snapshots, not a live archive subscription. */
export function createIdentityArchives(
  reader: RelayReader,
  authority: string | undefined,
  notify = (listener: () => void) => listener(),
) {
  const available = !!authority && HEX.test(authority);
  const listeners = new Set<() => void>();
  let closed = false;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  // Keep only the ordering fence across cache clears; never revive old contents.
  // This is session-local rollback resistance, not a cross-device durable fence.
  let head: Pick<RelayEvent, "id" | "created_at"> | undefined;
  let snapshot: IdentityArchiveSnapshot = Object.freeze({
    status: available ? "idle" : "unavailable",
    archived: empty,
  });
  function publish(next: IdentityArchiveSnapshot) {
    snapshot = Object.freeze(next);
    for (const listener of listeners) notify(listener);
  }
  function refresh(): Promise<void> {
    if (closed || !available || !authority) return Promise.resolve();
    if (pending) return pending;
    const owned = new AbortController();
    controller = owned;
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    pending = completion;
    publish({ status: "loading", archived: empty });
    void (async () => {
      try {
        if (closed || owned.signal.aborted) return;
        const events = await reader.read(
          [{ kinds: [13535], authors: [authority], limit: 1 }],
          { signal: owned.signal, priority: "background", fresh: true },
        );
        if (closed || owned.signal.aborted) return;
        const event = events[0];
        const markers = event?.tags.filter(([name]) => name === "-");
        if (
          events.length !== 1 ||
          !event ||
          event.kind !== 13535 ||
          event.pubkey !== authority ||
          event.content !== "" ||
          markers?.length !== 1 ||
          markers[0]?.length !== 1 ||
          byteSize(event) > MAX_BYTES
        )
          throw new Error("Invalid archive snapshot");
        // NIP-01 ordering also applies when the relay replays an older snapshot.
        // Re-reading the identical head is valid; a losing equal-time id is not.
        if (
          head &&
          (event.created_at < head.created_at ||
            (event.created_at === head.created_at && event.id > head.id))
        )
          throw new Error("Stale archive snapshot");
        const archived = [
          ...new Set(
            event.tags.flatMap(([name, key]) =>
              name === "p" && key && HEX.test(key) ? [key] : [],
            ),
          ),
        ].sort();
        head = { id: event.id, created_at: event.created_at };
        publish({
          status: "ready",
          archived: Object.freeze(archived),
          eventId: event.id,
          createdAt: event.created_at,
          readAt: Date.now(),
        });
      } catch {
        if (!closed && !owned.signal.aborted)
          publish({
            status: "error",
            archived: empty,
            error:
              "Archive visibility is unknown. Retry to obtain a valid current relay snapshot (2 MiB limit).",
          });
      } finally {
        if (controller === owned) {
          controller = undefined;
          pending = undefined;
        }
        finish();
      }
    })();
    return completion;
  }
  function clear() {
    controller?.abort();
    controller = undefined;
    pending = undefined;
    publish({
      status: closed || !available ? "unavailable" : "idle",
      archived: empty,
    });
  }
  return {
    queries: Object.freeze({
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      state(pubkey: string): "unknown" | "archived" | "not-archived" {
        if (snapshot.status !== "ready" || !HEX.test(pubkey)) return "unknown";
        return snapshot.archived.includes(pubkey) ? "archived" : "not-archived";
      },
      ensure: () =>
        snapshot.status === "idle" ? refresh() : (pending ?? Promise.resolve()),
      refresh,
    }),
    clear,
    dispose() {
      closed = true;
      clear();
      listeners.clear();
    },
  };
}
