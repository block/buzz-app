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
  /** `relayCount` counts the relay's page before visibility filtering. */
  readPage(
    filters: readonly ReadFilter[],
    settings?: ReadOptions,
  ): Promise<{ events: readonly EventData[]; relayCount: number }>;
  subscribeLive(
    listener: LiveListener,
    options?: { replay?: boolean },
  ): () => void;
  live: Readonly<{
    /** A channel whose route re-establishes reads its head again (pending). */
    snapshot(): Readonly<{
      heads: readonly Readonly<{ channelId?: string; state: string }>[];
    }>;
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
/** Overlay pages read per chunk of pins before folding what arrived. */
const OVERLAY_PAGES = 20;

const stores = new WeakMap<PinSource, ReturnType<typeof createPinLists>>();

/** One list per channel the UI asked about: read once, then kept current by
 * the channel's live subscription and its replay. When channels catch up
 * after their routes re-establish, their watched lists are read again in one
 * read, since a cut replay may not carry a change. A failed read stays failed
 * until `retry` or the next catch-up. */
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
            // A repair read must not be served state older than the gap.
            consistency: "strong",
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
    const catchingUp = () =>
      new Set(
        source.live
          .snapshot()
          .heads.flatMap((head) =>
            head.state === "pending" && head.channelId ? [head.channelId] : [],
          ),
      );
    let pending = catchingUp();
    source.live.subscribe(() => {
      const now = catchingUp();
      const stale: string[] = [];
      for (const id of now) {
        const entry = entries.get(id);
        if (pending.has(id) || !entry || entry.reading) continue;
        // An unwatched list is read again when next asked for.
        if (entry.listeners.size) stale.push(id);
        else entries.delete(id);
      }
      pending = now;
      for (let index = 0; index < stale.length; index += READ_CHUNK)
        read(stale.slice(index, index + READ_CHUNK));
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
      } else if (entry.snapshot.status === "error" && !entry.listeners.size)
        // A revisit tries a failed list once more.
        read([channelId]);
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
 * timeline applies them. Reads are strong: a reload follows an observed list
 * change, edit or deletion, and must not be served older state. An id the relay no longer returns is absent from the
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
                consistency: "strong",
              },
            ],
            settings,
          )),
        ];
        // Newest first, every page over every pin: a reference settles
        // nothing until folding checks who may change that message.
        const seen = new Set<string>();
        let until: number | undefined;
        for (let pages = 0; pages < OVERLAY_PAGES; pages++) {
          const page = await source.readPage(
            [
              {
                kinds: [5, 9005, 40003],
                "#e": chunk,
                limit: OVERLAY_LIMIT,
                consistency: "strong",
                ...(until === undefined ? {} : { until }),
              },
            ],
            settings,
          );
          const fresh = page.events.filter((event) => !seen.has(event.id));
          for (const event of fresh) seen.add(event.id);
          read.push(...fresh);
          // Fullness is the relay's count: visibility may drop some events.
          if (page.relayCount < OVERLAY_LIMIT || !fresh.length) break;
          // Inclusive, so events sharing the oldest second are not skipped.
          until = Math.min(...fresh.map((event) => event.created_at));
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
