import {
  hasEventProof,
  newer,
  type EventData,
  type ReadFilter,
  type RelayEvent,
} from "./events";
import { soloFork, type SoloFork } from "./solo-fork-protocol";

import type { ChannelMessage } from "./contracts";
import { foldMessages } from "./fold";
import { eventMs, compareMessages } from "./message-order";
import { windowFilter, parseWindow, type WindowCursor } from "./window";
import { listByteSize } from "./budget";
import { RELAY_READ_BYTES } from "./reader";

export type ForkReader = Readonly<{
  read(
    filters: readonly ReadFilter[],
    signal: AbortSignal,
  ): Promise<readonly EventData[]>;
  relayAuthor(): string | undefined;
}>;

/** Fresh authorized metadata: absence/error is unresolved, never an ordinary chat. */
export async function readSoloFork(
  reader: ForkReader,
  channelId: string,
  signal: AbortSignal,
): Promise<SoloFork | undefined> {
  const author = reader.relayAuthor();
  if (!author)
    throw new Error("The community's metadata authority is unavailable.");
  const events = await reader.read(
    [
      {
        kinds: [39000],
        authors: [author],
        "#d": [channelId],
        limit: 1,
        consistency: "strong",
      },
    ],
    signal,
  );
  signal.throwIfAborted();
  const metadata = events
    .filter(
      (event) =>
        hasEventProof(event) &&
        event.kind === 39000 &&
        event.pubkey === author &&
        event.tags.some((tag) => tag[0] === "d" && tag[1] === channelId),
    )
    .reduce<EventData | undefined>(
      (previous, event) => newer(previous, event),
      undefined,
    );
  if (!metadata)
    throw new Error(
      "The chat's signed metadata could not be confirmed. Retry without creating another chat.",
    );
  return soloFork(metadata);
}

/** Shared UI/Claude budget, destination rows first; ancestry is history, not authority. */
export const SOLO_SEED_LIMIT = 12;
export type SoloSeed = Readonly<{
  fork: SoloFork;
  inherited: readonly ChannelMessage[];
  destination: readonly ChannelMessage[];
  messages: readonly ChannelMessage[];
}>;

/** Reconstruct the current live seed with the caller's authorized reader. No cache or parent viewport. */
export async function readSoloSeed(
  reader: ForkReader,
  channelId: string,
  signal: AbortSignal,
  options: Readonly<{
    before?: EventData;
    signingAuthority?: string;
    agentOwner?: (pubkey: string) => string | undefined;
  }> = {},
): Promise<SoloSeed | undefined> {
  let reads = 0;
  let bytes = 0;
  // One bounded reconstruction across all ancestors, not a budget per ancestor.
  const bounded: ForkReader = {
    relayAuthor: reader.relayAuthor,
    async read(filters, caller) {
      caller.throwIfAborted();
      if (++reads > 32)
        throw new Error("The fork's history exceeds the read budget.");
      const events = await reader.read(filters, caller);
      caller.throwIfAborted();
      bytes += listByteSize(events);
      if (bytes > RELAY_READ_BYTES)
        throw new Error("The fork's history exceeds the read budget.");
      if (events.some((event) => !hasEventProof(event)))
        throw new Error("The fork's history is not signature verified.");
      return events;
    },
  };
  const fork = await readSoloFork(bounded, channelId, signal);
  if (!fork) return;
  const relayAuthor = bounded.relayAuthor();
  if (!relayAuthor)
    throw new Error("The community's metadata authority is unavailable.");
  const authority: string = relayAuthor;
  const seen = new Set([channelId]);
  const key = (event: EventData) => ({
    id: event.id,
    createdAt: event.created_at,
    createdAtMs: eventMs(event),
  });
  async function local(
    id: string,
    count: number,
    cutoff?: EventData,
    inclusive = true,
  ) {
    // NIP-CW requires both cursor fields. The next second's maximal ID
    // includes the entire cutoff second, whose rendered order uses `ms`.
    let cursor: WindowCursor | null = cutoff
      ? { createdAt: cutoff.created_at + 1, eventId: "f".repeat(64) }
      : null;
    const events = new Map<string, EventData>();
    for (;;) {
      const response = await bounded.read(
        [windowFilter(id, cursor, 200)],
        signal,
      );
      const page = parseWindow(id, cursor, authority, response.map(verified));
      for (const event of page.events) events.set(event.id, event);
      const chatIds = new Set(
        [...events.values()]
          .filter((event) => [9, 40002].includes(event.kind))
          .map((event) => event.id),
      );
      const rows = foldMessages(id, authority, [...events.values()], options)
        .filter(
          (row) =>
            chatIds.has(row.id) &&
            (!cutoff ||
              (inclusive
                ? compareMessages(row, key(cutoff)) <= 0
                : compareMessages(row, key(cutoff)) < 0)),
        )
        .sort(compareMessages)
        .slice(-count);
      // Complete the oldest selected second before taking its newest `ms` rows.
      const oldest = rows[0];
      if (
        !page.hasMore ||
        (rows.length === count &&
          oldest &&
          page.cursor &&
          page.cursor.createdAt < oldest.createdAt)
      )
        return rows;
      cursor = page.cursor;
    }
  }
  async function inherited(
    pointer: SoloFork,
    count: number,
  ): Promise<readonly ChannelMessage[]> {
    if (seen.has(pointer.channelId))
      throw new Error("The fork's ancestry contains a cycle.");
    seen.add(pointer.channelId);
    const events = await bounded.read(
      [
        {
          kinds: [9, 40002],
          ids: [pointer.messageId],
          "#h": [pointer.channelId],
          limit: 1,
          consistency: "strong",
        },
      ],
      signal,
    );
    const cutoff = events.find(
      (event) =>
        event.id === pointer.messageId &&
        [9, 40002].includes(event.kind) &&
        event.tags.some(
          ([name, value]) => name === "h" && value === pointer.channelId,
        ),
    );
    if (!cutoff) throw new Error("The fork's cutoff message is unavailable.");
    const rows = await local(pointer.channelId, count, cutoff);
    if (rows.length === count) return rows;
    const parent = await readSoloFork(bounded, pointer.channelId, signal);
    return parent
      ? [...(await inherited(parent, count - rows.length)), ...rows]
      : rows;
  }
  const destination = await local(
    channelId,
    SOLO_SEED_LIMIT,
    options.before,
    false,
  );
  const parent =
    destination.length < SOLO_SEED_LIMIT
      ? await inherited(fork, SOLO_SEED_LIMIT - destination.length)
      : [];
  return {
    fork,
    inherited: parent,
    destination,
    messages: [...parent, ...destination],
  };
}

// AgentReads intentionally exposes EventData; require transport admission before
// handing a record to the existing signed NIP-CW parser. Never re-verify local intent.
function verified(event: EventData): RelayEvent {
  if (!hasEventProof(event))
    throw new Error("The fork's history is not signature verified.");
  return event as RelayEvent;
}
