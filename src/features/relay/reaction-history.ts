import type { RelayReader } from "./reader";
import { eventVisibility } from "./event-access";
import type { EventData, ReadFilter } from "./events";
import { foldMessages } from "./fold";
import { threadReference } from "./thread-reference";
import type { CustomEmoji } from "./emoji";

export type ReactionCursor = { until: number; before_id: string };
export type ReactionEntry = {
  id: string;
  authorId: string;
  channelId: string;
  messageId: string;
  rootId?: string | undefined;
  createdAt: number;
  content: string;
  emoji?: CustomEmoji | undefined;
  preview: string;
};
const order = (a: EventData, b: EventData) =>
  b.created_at - a.created_at || a.id.localeCompare(b.id);
const cursorOf = (event: EventData): ReactionCursor => ({
  until: event.created_at,
  before_id: event.id,
});
const older = (event: EventData, cursor: ReactionCursor) =>
  event.created_at < cursor.until ||
  (event.created_at === cursor.until && event.id > cursor.before_id);

/** Only the original message proves ownership, never a reaction's claimed p tag.
 * Use the timeline fold for edits, reaction removal and moderation deletion. */
export function projectReactionHistory(
  events: readonly EventData[],
  viewer: string,
  relayAuthor: string,
  channels: readonly string[],
  signingAuthority?: string,
): ReactionEntry[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  const visible = eventVisibility(
    (id) => channels.includes(id),
    (id) => byId.get(id),
  );
  const admitted = events.filter(visible);
  const rows: ReactionEntry[] = [];
  for (const channelId of channels) {
    const scoped = admitted.filter((event) => {
      const hs = event.tags.filter(([name]) => name === "h");
      return (
        (hs.length === 1 && hs[0]?.[1] === channelId) ||
        (hs.length === 0 && [5, 9005, 40003].includes(event.kind))
      );
    });
    for (const message of foldMessages(channelId, relayAuthor, scoped, {
      includeReplies: true,
      signingAuthority,
    })) {
      const original = byId.get(message.id);
      if (
        !original ||
        original.pubkey !== viewer ||
        ![9, 40002].includes(original.kind)
      )
        continue;
      for (const reaction of message.reactions) {
        // Duplicate events from one person count once, as on the message itself.
        const newest = new Map<string, EventData>();
        for (const { id, authorId } of reaction.events) {
          const event = byId.get(id);
          if (!event || authorId === viewer) continue;
          const previous = newest.get(authorId);
          if (!previous || order(event, previous) < 0)
            newest.set(authorId, event);
        }
        for (const event of newest.values())
          rows.push({
            id: event.id,
            authorId: event.pubkey,
            channelId,
            messageId: message.id,
            rootId: threadReference(original)?.rootId,
            createdAt: event.created_at,
            content: reaction.content || "+",
            emoji: reaction.emoji,
            preview: message.content,
          });
      }
    }
  }
  return rows.sort(
    (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
}

/** Reactions from older clients omit p tags. Page kind 7 history instead of
 * silently losing those reactions or limiting discovery to recent own messages.
 * One user-requested page scans at most 100 reactions; no per-channel fan-out. */
export async function readReactionPage(
  session: {
    read: RelayReader["read"];
    viewer?: string | undefined;
    relayAuthor?: string | undefined;
    signingAuthority?: string | undefined;
  },
  channels: readonly string[],
  signal: AbortSignal,
  cursor?: ReactionCursor,
): Promise<{ rows: ReactionEntry[]; cursor: ReactionCursor | undefined }> {
  if (!session.viewer || !channels.length)
    return { rows: [], cursor: undefined };
  const page = [
    ...(await session.read(
      [
        {
          kinds: [7],
          "#h": channels,
          limit: 100,
          ...cursor,
        },
      ],
      { signal },
    )),
  ].sort(order);
  if (cursor && page.some((event) => !older(event, cursor)))
    throw new Error("Reaction history did not advance. Refresh to try again.");
  const last = page.at(-1);
  if (!last) return { rows: [], cursor: undefined };
  const ids = [
    ...new Set(
      page.flatMap((event) => {
        const id = event.tags.find(([name]) => name === "e")?.[1];
        return id && /^[0-9a-f]{64}$/.test(id) ? [id] : [];
      }),
    ),
  ];
  const originals = ids.length
    ? await session.read([{ ids, limit: ids.length }], { signal })
    : [];
  const own = originals.filter((event) => event.pubkey === session.viewer);
  const ownIds = new Set(own.map((event) => event.id));
  const reactions = page.filter((event) =>
    ownIds.has(event.tags.find(([name]) => name === "e")?.[1] ?? ""),
  );
  async function overlays(targets: readonly string[], kinds: number[]) {
    const result: EventData[] = [];
    if (!targets.length) return result;
    let after: ReactionCursor | undefined;
    for (let batch = 0; batch < 5; batch++) {
      const filter: ReadFilter = { kinds, "#e": targets, limit: 500, ...after };
      const updates = [...(await session.read([filter], { signal }))].sort(
        order,
      );
      const previous = after;
      if (previous && updates.some((event) => !older(event, previous)))
        throw new Error(
          "Reaction updates did not advance. Refresh to try again.",
        );
      const lastUpdate = updates.at(-1);
      if (!lastUpdate) return result;
      result.push(...updates);
      after = cursorOf(lastUpdate);
    }
    throw new Error("Too many message updates to safely display reactions.");
  }
  const updates = await overlays(
    [...ownIds, ...reactions.map((event) => event.id)],
    [40003, 5, 9005],
  );
  const editDeletes = await overlays(
    updates.filter((event) => event.kind === 40003).map((event) => event.id),
    [5, 9005],
  );
  return {
    rows: projectReactionHistory(
      [...own, ...reactions, ...updates, ...editDeletes],
      session.viewer,
      session.relayAuthor ?? "",
      channels,
      session.signingAuthority,
    ),
    cursor: cursorOf(last),
  };
}
