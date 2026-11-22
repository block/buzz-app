import type { EventData } from "./events";
import { channelRowKind, membershipChange } from "./membership";
import { eventChannel } from "./placement";

/** History the relay moved out of a conversation (kind 41014), as its source
 * saw the notice: the channel it left, the message the move began at, when the
 * relay posted the notice, and the conversation it went to. */
export type HistoryMove = Readonly<{
  /** The notice's event id: each move is applied once. */
  id: string;
  channelId: string;
  cut: string;
  at: number;
  to: string;
}>;

/** The moves among verified events, from the relay's notices posted in the
 * source. The same move is also announced in the destination, which only
 * receives history and has nothing to drop. */
export function historyMoves(
  events: readonly EventData[],
  relayAuthor: string,
): HistoryMove[] {
  const moves: HistoryMove[] = [];
  for (const event of events) {
    const change = membershipChange(event, relayAuthor);
    if (change?.type === "history_moved" && eventChannel(event) === change.from)
      moves.push({
        id: event.id,
        channelId: change.from,
        cut: change.cut,
        at: event.created_at,
        to: change.to,
      });
  }
  return moves;
}

/** Auxiliaries that name their target by `e`: reactions, edits, deletions and
 * summaries. */
const AUXILIARY = new Set([5, 7, 9005, 40003, 39005]);

/** Where the cut lies in what a cache holds: the cut message's time, or
 * undefined when the cache does not hold it. */
export const cutTime = (move: HistoryMove, events: Iterable<EventData>) => {
  for (const event of events)
    if (event.id === move.cut) return event.created_at;
};

/**
 * The ids to drop from a cache of the source's events once its history moved:
 * its messages and other rows from the cut on, up to the notice (later ones
 * were sent after the move and stay), and every reaction, edit and deletion of
 * a dropped message, whatever its own time. The relay's notices stay, as the
 * record that it happened. Replies from the cut on go with it, so a thread
 * leaves with the message that began it.
 *
 * Without the cut in the cache (`cutAt` undefined), `all` decides: a cache that
 * predates the move holds nothing the cut leaves behind, so every row up to the
 * notice is dropped; a cache read since holds only what stayed, so nothing is.
 */
export function movedIds(
  events: Iterable<EventData>,
  move: HistoryMove,
  cutAt: number | undefined,
  all: boolean,
): Set<string> {
  const pool = [...events].filter(
    (event) =>
      eventChannel(event) === move.channelId || AUXILIARY.has(event.kind),
  );
  const ids = new Set<string>();
  if (cutAt === undefined && !all) return ids;
  for (const event of pool)
    if (
      channelRowKind(event.kind) &&
      event.kind !== 40099 &&
      eventChannel(event) === move.channelId &&
      event.created_at >= (cutAt ?? 0) &&
      event.created_at <= move.at
    )
      ids.add(event.id);
  // An auxiliary goes with its target, and a deletion of that with it.
  for (let changed = true; changed; ) {
    changed = false;
    for (const event of pool) {
      if (ids.has(event.id) || !AUXILIARY.has(event.kind)) continue;
      if (event.tags.some(([name, id]) => name === "e" && ids.has(id ?? ""))) {
        ids.add(event.id);
        changed = true;
      }
    }
  }
  return ids;
}
