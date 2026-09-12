import type { ChannelMessage } from "./contracts";
import type { EventData, RelayEvent } from "./events";
import type { LocalEvents } from "./outbox";
import type { RelayReader } from "./reader";
import { byteSize } from "./budget";
import { foldMessages } from "./fold";

const AUX = [5, 7, 9005, 40003, 39005];
export const DETAIL_READ_LIMIT = 500;
const MAX_BYTES = 4 * 1024 * 1024;
export class DetailLimitError extends Error {
  constructor() {
    super(
      "Message detail exceeded its evidence limit. Open the channel or retry.",
    );
  }
}
export type MessageDetailSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "unavailable" | "error";
  target: ChannelMessage | undefined;
  error: string | undefined;
  limited: boolean;
}>;
export type MessageDetailView = {
  snapshot(): MessageDetailSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  dispose(): void;
};

/** An isolated exact row, not a channel window or a claim of contiguous history. */
export function createMessageDetail({
  channelId,
  messageId,
  relayAuthor,
  reader,
  local,
  canAccess,
  visible,
  notify,
}: {
  channelId: string;
  messageId: string;
  relayAuthor: string;
  reader: RelayReader;
  local: LocalEvents | undefined;
  canAccess(): boolean;
  visible(events: readonly RelayEvent[]): readonly RelayEvent[];
  notify(listener: () => void): void;
}) {
  let disposed = false;
  let controller: AbortController | undefined;
  let again = false;
  let remote: readonly RelayEvent[] = [];
  let readable = false;
  let snapshot: MessageDetailSnapshot = Object.freeze({
    status: "idle",
    target: undefined,
    error: undefined,
    limited: false,
  });
  const listeners = new Set<() => void>();
  const content = (event: EventData) =>
    [9, 40002].includes(event.kind) &&
    event.tags.some(([name, value]) => name === "h" && value === channelId);
  const union = (...batches: readonly (readonly RelayEvent[])[]) => [
    ...new Map(batches.flat().map((event) => [event.id, event])).values(),
  ];
  function related<T extends EventData>(events: readonly T[]) {
    const ids = new Set([messageId, ...remote.map((event) => event.id)]);
    const result = new Map(
      events
        .filter((event) => content(event) && event.id === messageId)
        .map((event) => [event.id, event]),
    );
    for (let hop = 0; hop < 2; hop++) {
      for (const event of events) {
        if (
          AUX.includes(event.kind) &&
          event.tags.some(
            ([name, value]) => name === "e" && ids.has(value ?? ""),
          )
        ) {
          result.set(event.id, event);
          ids.add(event.id);
        }
      }
    }
    return [...result.values()];
  }
  function publish(patch: Partial<MessageDetailSnapshot> = {}) {
    if (disposed) return;
    const operations = canAccess() ? (local?.snapshot() ?? []) : [];
    const inputs = new Map(
      remote.map((event) => [event.id, event as EventData]),
    );
    for (const event of related(
      operations
        .filter((item) => item.delivery !== "failed")
        .map((item) => item.event),
    ))
      inputs.set(event.id, event);
    const rows =
      readable && canAccess()
        ? foldMessages(channelId, relayAuthor, [...inputs.values()], {
            includeReplies: true,
          })
        : [];
    const target = rows.find((row) => row.id === messageId);
    const next = { ...snapshot, ...patch };
    // A live author deletion must withdraw a previously successful target too.
    if (next.status === "ready" && !target) next.status = "unavailable";
    snapshot = Object.freeze({
      ...next,
      target,
    });
    for (const listener of listeners) notify(listener);
  }
  function retain(events: readonly RelayEvent[]) {
    if (events.length >= DETAIL_READ_LIMIT || byteSize(events) > MAX_BYTES)
      throw new DetailLimitError();
    remote = events;
  }
  function fail(error: unknown) {
    readable = false;
    if (error instanceof DetailLimitError) remote = [];
    publish({
      status: "error",
      error: String(error),
      limited: error instanceof DetailLimitError,
    });
  }
  function receive(events: readonly RelayEvent[]) {
    if (disposed || !canAccess()) return;
    try {
      const incoming = related(events);
      if (!incoming.length) return;
      retain(union(remote, incoming));
      publish();
    } catch (error) {
      controller?.abort();
      controller = undefined;
      again = false;
      fail(error);
    }
  }
  function purge(clear = false) {
    controller?.abort();
    controller = undefined;
    again = false;
    readable = false;
    if (clear || !canAccess()) {
      remote = [];
    } else remote = visible(remote);
    publish({
      status: "error",
      limited: false,
      error: canAccess()
        ? "Message read interrupted. Retry to continue."
        : "This channel is no longer available.",
    });
  }
  async function refresh() {
    if (disposed) return;
    if (controller) {
      again = true;
      return;
    }
    if (!canAccess()) {
      purge();
      return;
    }
    const owned = new AbortController();
    controller = owned;
    const active = () =>
      !disposed && !owned.signal.aborted && controller === owned && canAccess();
    readable = false;
    publish({ status: "loading", error: undefined, limited: false });
    try {
      const selected = await reader.read(
        [{ ids: [messageId], "#h": [channelId], limit: 1 }],
        { signal: owned.signal },
      );
      if (!active()) return;
      const target = selected.find(
        (event) => event.id === messageId && content(event),
      );
      if (!target) {
        publish({ status: "unavailable" });
        return;
      }
      retain(union(remote, [target]));
      // Generic ID reads have no include_aux expansion. Query supported NIP-01
      // references explicitly, without #h: legacy edits/deletes may be reference-only.
      const direct = await reader.read(
        [
          {
            kinds: AUX,
            "#e": [messageId],
            limit: DETAIL_READ_LIMIT,
          },
        ],
        { signal: owned.signal },
      );
      if (!active()) return;
      retain(union(remote, related(direct)));
      const auxiliaries = remote
        .filter((event) => AUX.includes(event.kind))
        .map((event) => event.id);
      if (auxiliaries.length) {
        const tombstones = await reader.read(
          [{ kinds: [5, 9005], "#e": auxiliaries, limit: DETAIL_READ_LIMIT }],
          { signal: owned.signal },
        );
        if (!active()) return;
        retain(union(remote, related(tombstones)));
      }
      readable = true;
      publish({ status: "ready", error: undefined });
    } catch (error) {
      if (active()) fail(error);
    } finally {
      if (controller === owned) {
        controller = undefined;
        if (again && !disposed) {
          again = false;
          void refresh();
        }
      }
    }
  }
  return {
    channelId,
    event: (id: string) => remote.find((event) => event.id === id),
    receive,
    purge,
    changed: () => publish(),
    view: {
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      refresh,
      dispose() {
        listeners.clear();
        purge(true);
        disposed = true;
      },
    } satisfies MessageDetailView,
  };
}
