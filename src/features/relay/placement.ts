import type { EventData, ReadFilter } from "./events";
import { channelSourceKind } from "./channel-kinds";

/**
 * Where a channel event lives, when that is not the channel its signed `h` tag
 * names.
 *
 * Moving DM history into a new conversation (kind 41014) leaves the moved
 * events exactly as signed, so each keeps the source's `h`. The relay then
 * serves them under the destination: an `#h: [destination]` read returns events
 * tagged with the source. The reader is the one place that knows which filter an
 * event answered, so it records the destination here, and every consumer that
 * asks "which channel is this event in" goes through `eventChannel` /
 * `inChannel` instead of reading `h` itself.
 *
 * Verified events are frozen and proof-tracked by identity, so the tag cannot be
 * rewritten and a copy would lose its proof; a side table keyed by the event
 * object leaves the event untouched and is forgotten with it. Placement is
 * scoped to the object a read produced: an event reread later is placed again by
 * that read, and one restored from disk is placed by `restorePlacement`.
 */
const placed = new WeakMap<EventData, string>();

const homes = (event: EventData) => event.tags.filter(([name]) => name === "h");

/** Kinds that name a channel in `h` and are never relayed on another's say:
 * notices are the relay's own statement about the channel they are posted in. */
const placeable = (kind: number) => channelSourceKind(kind) && kind !== 40099;

/** The single channel every filter of a read names, when they all agree. Only
 * reads of what a conversation holds count: its history windows, its threads
 * and a lookup by id. A broad evidence read (unread counting, say) says nothing
 * about where an event belongs. */
function servedChannel(filters: readonly ReadFilter[]) {
  let channel: string | undefined;
  for (const filter of filters) {
    const [only, ...rest] = filter["#h"] ?? [];
    if (
      !only ||
      rest.length ||
      (channel && channel !== only) ||
      !(filter.top_level || filter.thread_window || filter.ids?.length)
    )
      return undefined;
    channel = only;
  }
  return channel;
}

/** Records the channel a read served each event under, for the events whose
 * single `h` names another channel. Reads of several channels, and reads with no
 * channel filter, place nothing: only a one-channel answer says where an event
 * lives. */
export function placeServed(
  filters: readonly ReadFilter[],
  events: readonly EventData[],
) {
  const channel = servedChannel(filters);
  if (!channel) return;
  for (const event of events) {
    if (!placeable(event.kind)) continue;
    const tags = homes(event);
    if (tags.length === 1 && tags[0]?.[1] && tags[0][1] !== channel)
      placed.set(event, channel);
  }
}

/** Restores a saved head's placements: the ids it recorded, within its channel. */
export function restorePlacement(
  channel: string,
  ids: ReadonlySet<string>,
  events: readonly EventData[],
) {
  for (const event of events)
    if (ids.has(event.id) && placeable(event.kind)) placed.set(event, channel);
}

/** The ids of the events placed in `channel`, for saving with its head. */
export const placedIn = (channel: string, events: readonly EventData[]) =>
  events.filter((event) => placed.get(event) === channel).map(({ id }) => id);

/** Where a read placed an event, when it did. */
export const placedChannel = (event: EventData) => placed.get(event);

/** The channel an event lives in: where it was placed, else its one `h`. */
export function eventChannel(event: EventData): string | undefined {
  const channel = placed.get(event);
  if (channel) return channel;
  const [home, ...rest] = homes(event);
  return home && !rest.length ? home[1] || undefined : undefined;
}

/** Whether an event is in `channel`, by placement or by any `h` it carries. */
export function inChannel(event: EventData, channel: string) {
  const home = placed.get(event);
  return home
    ? home === channel
    : event.tags.some(([name, value]) => name === "h" && value === channel);
}
