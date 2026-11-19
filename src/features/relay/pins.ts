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
  /** Who may sign messages for others (an `actor` tag); see `foldMessages`. */
  workflowAuthority?: string | undefined;
  profiles?: Readonly<{
    owner?: ((pubkey: string) => string | undefined) | undefined;
  }>;
  read(
    filters: readonly ReadFilter[],
    settings?: ReadOptions,
  ): Promise<readonly EventData[]>;
  subscribeLive(
    listener: LiveListener,
    options?: { replay?: boolean },
  ): () => void;
  live: Readonly<{
    snapshot(): Readonly<{ status: string }>;
    subscribe(listener: () => void): () => void;
  }>;
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
  reading?: Promise<void> | undefined;
};

const READ_CHUNK = 100;
const OVERLAY_LIMIT = 500;

const stores = new WeakMap<PinSource, ReturnType<typeof createPinLists>>();

/** One list per channel the UI asked about: read once, then kept current by
 * the channel's live subscription and its replay. A reconnect reads every
 * watched list again in one read, since a cut replay may not carry a change.
 * A failed read stays failed until `retry` or the next reconnect. */
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
  function read(channelIds: readonly string[]) {
    const relayAuthor = source.relayAuthor;
    const wanted = channelIds.flatMap((id) => {
      const entry = entries.get(id);
      return entry && !entry.reading ? [[id, entry] as const] : [];
    });
    if (!wanted.length) return;
    // Without NIP-11 `self` no list can be verified: show none.
    if (!relayAuthor) {
      for (const [, entry] of wanted) publish(entry, { status: "ready" });
      return;
    }
    const reading = source
      .read(
        [
          {
            kinds: [PIN_LIST_KIND],
            authors: [relayAuthor],
            "#d": wanted.map(([id]) => id),
            limit: wanted.length,
          },
        ],
        { priority: "background" },
      )
      .then(
        (events) => {
          accept(events);
          // No list yet is an empty list.
          for (const [, entry] of wanted)
            if (entry.snapshot.status !== "ready")
              publish(entry, { status: "ready" });
        },
        () => {
          // A list already shown, or one heard live meanwhile, still stands.
          for (const [, entry] of wanted)
            if (entry.snapshot.status !== "ready")
              publish(entry, { status: "error" });
        },
      )
      .finally(() => {
        for (const [, entry] of wanted)
          if (entry.reading === reading) entry.reading = undefined;
      });
    for (const [, entry] of wanted) entry.reading = reading;
    for (const [, entry] of wanted)
      if (entry.snapshot.status === "error")
        publish(entry, { status: "loading" });
  }
  function listen() {
    if (listening) return;
    listening = true;
    // Kept for the session: lists stay current once asked for. Replay
    // listeners hear live batches too.
    source.subscribeLive(({ events }) => accept(events), { replay: true });
    let connected = source.live.snapshot().status === "connected";
    source.live.subscribe(() => {
      const now = source.live.snapshot().status === "connected";
      if (now && !connected) {
        // An unwatched list is read again when next asked for.
        for (const [id, entry] of entries)
          if (!entry.listeners.size && !entry.reading) entries.delete(id);
        const watched = [...entries.keys()];
        for (let index = 0; index < watched.length; index += READ_CHUNK)
          read(watched.slice(index, index + READ_CHUNK));
      }
      connected = now;
    });
  }
  return {
    snapshot: (channelId: string) =>
      entries.get(channelId)?.snapshot ?? LOADING_PINS,
    subscribe(channelId: string, listener: () => void) {
      listen();
      let entry = entries.get(channelId);
      if (!entry) {
        entry = { snapshot: LOADING_PINS, listeners: new Set() };
        entries.set(channelId, entry);
        read([channelId]);
      }
      entry.listeners.add(listener);
      const owned = entry;
      return () => {
        owned.listeners.delete(listener);
      };
    },
    /** Reads a list again, as after a failed read. */
    retry: (channelId: string) => read([channelId]),
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

/** Pinned messages by id, with their edits and deletions applied as the
 * timeline applies them. An id the relay no longer returns is absent from the
 * map: deleted or erased. A failed read rejects; callers must not treat it as
 * a deletion. */
export async function readPinnedMessages(
  source: PinSource,
  channelId: string,
  ids: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, ChannelMessage>> {
  const settings = { signal, priority: "background" } as const;
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += READ_CHUNK)
    chunks.push(ids.slice(index, index + READ_CHUNK));
  const events = (
    await Promise.all(
      chunks.map(async (chunk) => {
        const read = [
          ...(await source.read(
            [
              {
                kinds: [9, 40002, 40008],
                ids: chunk,
                "#h": [channelId],
                limit: chunk.length,
              },
            ],
            settings,
          )),
        ];
        // Newest first: once a message has an edit or a deletion, older
        // overlays cannot change it, so each page asks only for the rest.
        let open = chunk;
        let until: number | undefined;
        while (open.length) {
          const page = await source.read(
            [
              {
                kinds: [5, 9005, 40003],
                "#e": open,
                limit: OVERLAY_LIMIT,
                ...(until === undefined ? {} : { until }),
              },
            ],
            settings,
          );
          read.push(...page);
          if (page.length < OVERLAY_LIMIT) break;
          const seen = new Set(
            page.flatMap((event) =>
              event.tags.flatMap(([name, id]) =>
                name === "e" && id ? [id] : [],
              ),
            ),
          );
          open = open.filter((id) => !seen.has(id));
          until = Math.min(...page.map((event) => event.created_at));
        }
        return read;
      }),
    )
  ).flat();
  const wanted = new Set(ids);
  return new Map(
    foldMessages(channelId, source.relayAuthor ?? "", events, {
      includeReplies: true,
      signingAuthority: source.workflowAuthority,
      agentOwner: source.profiles?.owner,
    })
      .filter((row) => wanted.has(row.id))
      .map((row) => [row.id, row]),
  );
}
