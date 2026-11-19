import type { ChannelMessage } from "./contracts";
import { newer, type EventData, type ReadFilter } from "./events";
import { foldMessages } from "./fold";
import type { LiveListener } from "./incoming";
import type { ReadOptions } from "./reader";

/** Member-signed commands; the relay applies them and re-signs the list. */
export const PIN_KIND = 40010;
export const UNPIN_KIND = 40011;
/** The relay-signed pin list for one channel (`d`), newest pin first. */
export const PIN_LIST_KIND = 30623;

const HEX_ID = /^[0-9a-f]{64}$/;

/** The message ids a relay-signed list names for `channelId`, in display
 * order; undefined for any other event. */
export function pinnedIds(
  event: Pick<EventData, "kind" | "pubkey" | "tags">,
  relayAuthor: string | undefined,
  channelId: string,
): readonly string[] | undefined {
  if (
    event.kind !== PIN_LIST_KIND ||
    !relayAuthor ||
    event.pubkey !== relayAuthor ||
    event.tags.find(([name]) => name === "d")?.[1] !== channelId
  )
    return undefined;
  return [
    ...new Set(
      event.tags.flatMap(([name, id]) =>
        name === "e" && id && HEX_ID.test(id) ? [id] : [],
      ),
    ),
  ];
}

/** What the pin list needs from a session; `RelaySession` satisfies it. */
export type PinSource = Readonly<{
  relayAuthor?: string | undefined;
  read(
    filters: readonly ReadFilter[],
    settings?: ReadOptions,
  ): Promise<readonly EventData[]>;
  subscribeLive(
    listener: LiveListener,
    options?: { replay?: boolean },
  ): () => void;
}>;

export type PinSnapshot = Readonly<{
  status: "loading" | "ready" | "error";
  ids: readonly string[];
  set: ReadonlySet<string>;
}>;

export const LOADING_PINS: PinSnapshot = Object.freeze({
  status: "loading",
  ids: Object.freeze([]),
  set: new Set<string>(),
});

type Entry = {
  event?: EventData;
  snapshot: PinSnapshot;
  listeners: Set<() => void>;
  reading: boolean;
};

const stores = new WeakMap<PinSource, ReturnType<typeof createPinLists>>();

/** One list per channel the UI asked about: read once, then kept current by
 * the channel's live subscription (and its replay after a reconnect). A
 * failed read is retried when the next subscriber arrives. */
function createPinLists(source: PinSource) {
  const entries = new Map<string, Entry>();
  let listening = false;
  const publish = (entry: Entry, patch: Partial<PinSnapshot>) => {
    entry.snapshot = Object.freeze({ ...entry.snapshot, ...patch });
    for (const listener of [...entry.listeners]) listener();
  };
  function accept(events: readonly EventData[]) {
    for (const event of events) {
      if (event.kind !== PIN_LIST_KIND) continue;
      const channelId = event.tags.find(([name]) => name === "d")?.[1];
      const entry = channelId ? entries.get(channelId) : undefined;
      const ids =
        entry && channelId && pinnedIds(event, source.relayAuthor, channelId);
      if (!entry || !ids || newer(entry.event, event) !== event) continue;
      entry.event = event;
      publish(entry, { status: "ready", ids, set: new Set(ids) });
    }
  }
  const live: LiveListener = ({ events }) => accept(events);
  async function read(channelId: string, entry: Entry) {
    // Without NIP-11 `self` no list can be verified: show none.
    if (!source.relayAuthor) return publish(entry, { status: "ready" });
    entry.reading = true;
    if (entry.snapshot.status === "error")
      publish(entry, { status: "loading" });
    try {
      const events = await source.read(
        [
          {
            kinds: [PIN_LIST_KIND],
            authors: [source.relayAuthor],
            "#d": [channelId],
            limit: 1,
          },
        ],
        { priority: "background" },
      );
      accept(events);
      // No list yet is an empty list.
      if (entry.snapshot.status !== "ready")
        publish(entry, { status: "ready" });
    } catch {
      // A live list that arrived meanwhile still stands.
      if (entry.snapshot.status !== "ready")
        publish(entry, { status: "error" });
    } finally {
      entry.reading = false;
    }
  }
  return {
    snapshot: (channelId: string) =>
      entries.get(channelId)?.snapshot ?? LOADING_PINS,
    subscribe(channelId: string, listener: () => void) {
      // Kept for the session: lists stay current once asked for.
      if (!listening) {
        listening = true;
        source.subscribeLive(live);
        source.subscribeLive(live, { replay: true });
      }
      let entry = entries.get(channelId);
      if (!entry) {
        entry = {
          snapshot: LOADING_PINS,
          listeners: new Set(),
          reading: false,
        };
        entries.set(channelId, entry);
      }
      entry.listeners.add(listener);
      if (!entry.reading && entry.snapshot.status !== "ready")
        void read(channelId, entry);
      const owned = entry;
      return () => {
        owned.listeners.delete(listener);
      };
    },
  };
}

export function pinLists(source: PinSource) {
  let store = stores.get(source);
  if (!store) {
    store = createPinLists(source);
    stores.set(source, store);
  }
  return store;
}

const READ_CHUNK = 100;

/** Pinned messages by id, with their edits and deletions applied. An id the
 * relay no longer returns is absent from the map: deleted or erased. A failed
 * read rejects; callers must not treat it as a deletion. */
export async function readPinnedMessages(
  source: PinSource,
  channelId: string,
  ids: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, ChannelMessage>> {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += READ_CHUNK)
    chunks.push(ids.slice(index, index + READ_CHUNK));
  const events = (
    await Promise.all(
      chunks.map((chunk) =>
        source.read(
          [
            {
              kinds: [9, 40002, 40008],
              ids: chunk,
              "#h": [channelId],
              limit: chunk.length,
            },
            { kinds: [5, 9005, 40003], "#e": chunk, limit: 500 },
          ],
          { signal, priority: "background" },
        ),
      ),
    )
  ).flat();
  const wanted = new Set(ids);
  return new Map(
    foldMessages(channelId, source.relayAuthor ?? "", events, {
      includeReplies: true,
    })
      .filter((row) => wanted.has(row.id))
      .map((row) => [row.id, row]),
  );
}
