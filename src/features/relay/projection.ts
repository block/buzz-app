import { byteSize } from "./budget";
import type { EventData, ReadFilter, RelayEvent } from "./events";
import type { Delivery, OutgoingEvent } from "./outbox";

export type VisibleEvent = EventData &
  Readonly<{ delivery?: Delivery; error?: string | undefined }>;
/** Local eligibility for ordinary NIP-01 filters. Server-ranked search/feed results
 * cannot be inferred locally, so those require a feature-specific projection. */
export function matchesEvent(event: EventData, filter: ReadFilter): boolean {
  if (filter.search !== undefined || filter.feed_types !== undefined)
    return false;
  if (filter.ids && !filter.ids.some((id) => event.id.startsWith(id)))
    return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since)
    return false;
  if (filter.until !== undefined && event.created_at > filter.until)
    return false;
  if (
    filter.before_id &&
    filter.until === event.created_at &&
    event.id <= filter.before_id
  )
    return false;
  if (
    filter.top_level &&
    event.tags.some((tag) => tag[0] === "e" && tag[3] === "reply") &&
    !event.tags.some((tag) => tag[0] === "broadcast" && tag[1] === "1")
  )
    return false;
  return Object.entries(filter).every(
    ([name, values]) =>
      !name.startsWith("#") ||
      !Array.isArray(values) ||
      event.tags.some(
        (tag) => tag[0] === name.slice(1) && values.includes(tag[1]),
      ),
  );
}
/** A single merge rule for finite reads and subscribed filtered views. */
export function projectEvents(
  remote: readonly RelayEvent[],
  local: readonly OutgoingEvent[],
  filters: readonly ReadFilter[],
  previous: readonly VisibleEvent[] = [],
): readonly VisibleEvent[] {
  const events = new Map<string, VisibleEvent>(
    remote.map((event) => [event.id, event]),
  );
  for (const operation of local) {
    if (!filters.some((filter) => matchesEvent(operation.event, filter)))
      continue;
    events.set(
      operation.event.id,
      Object.freeze({
        ...(events.get(operation.event.id) ?? operation.event),
        delivery: operation.delivery,
        error: operation.error,
      }),
    );
  }
  const values = [...events.values()];
  if (
    filters.every(
      (filter) =>
        filter.search === undefined && filter.feed_types === undefined,
    )
  )
    values.sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
    );
  const old = new Map(previous.map((event) => [event.id, event]));
  const next = values.map((event) => {
    const existing = old.get(event.id);
    return existing &&
      existing.delivery === event.delivery &&
      existing.error === event.error
      ? existing
      : event;
  });
  return next.length === previous.length &&
    next.every((event, index) => event === previous[index])
    ? previous
    : Object.freeze(next);
}

/** Bounded retained evidence for owned views; eviction is chronological, not response-arrival order. */
export function retainEvents(
  events: readonly RelayEvent[],
): readonly RelayEvent[] {
  const unique = [
    ...new Map(events.map((event) => [event.id, event])).values(),
  ].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  const retained: RelayEvent[] = [];
  let bytes = 0;
  for (const event of unique) {
    const size = byteSize(event);
    if (bytes + size > 8 * 1024 * 1024 || retained.length >= 2000) break;
    retained.push(event);
    bytes += size;
  }
  return retained;
}
