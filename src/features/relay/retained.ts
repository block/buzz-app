import type { RetainedChannelEvidence } from "./contracts";
import type { EventData } from "./events";
import { newer } from "./events";
import { objectBody } from "./body";
import { threadReference } from "./thread-reference";
import { sessionRootPresentation } from "./channel-session";

const key = /^[0-9a-f]{64}$/;
// Positive evidence only. Larger identity lists remain deliberately incomplete.
const IDENTITY_LIMIT = 256;
export function retainedChannel(event: EventData): string | undefined {
  const channels = event.tags.filter(([name]) => name === "h");
  return channels.length === 1 && channels[0]?.length === 2
    ? channels[0][1] || undefined
    : undefined;
}
const identities = (values: readonly unknown[]) =>
  Object.freeze(
    [
      ...new Set(
        values.filter(
          (value): value is string =>
            typeof value === "string" && key.test(value),
        ),
      ),
    ].slice(0, IDENTITY_LIMIT),
  );

/** Private passive projection, not a history fold. Partition BEFORE overlays;
 * keep only compact positive evidence, never attachments or a raw event graph. */
export function retainedMessages(
  channelId: string,
  relayAuthor: string,
  incoming: Iterable<EventData>,
): RetainedChannelEvidence {
  const events = [...incoming].filter(
    (event) => retainedChannel(event) === channelId,
  );
  const byId = new Map(events.map((event) => [event.id, event]));
  const overlays = new Map<string, EventData[]>();
  const summaries = new Map<string, EventData>();
  for (const event of events) {
    if (event.kind === 39005) {
      const targets = event.tags.filter(([name]) => name === "e");
      const addresses = event.tags.filter(([name]) => name === "d");
      const target = targets[0]?.[1];
      const root = target && byId.get(target);
      if (
        event.pubkey !== relayAuthor ||
        targets.length !== 1 ||
        targets[0]?.length !== 2 ||
        addresses.length !== 1 ||
        addresses[0]?.length !== 2 ||
        addresses[0][1] !== target ||
        !root ||
        ![9, 40002].includes(root.kind) ||
        threadReference(root)
      )
        continue;
      const body = objectBody(event.content);
      if (!body || !Array.isArray(body.participants)) continue;
      summaries.set(root.id, newer(summaries.get(root.id), event));
    } else if ([40003, 5, 9005].includes(event.kind)) {
      for (const [name, target] of event.tags) {
        if (name !== "e" || !target) continue;
        const entries = overlays.get(target) ?? [];
        entries.push(event);
        overlays.set(target, entries);
      }
    }
  }
  const deleted = (event: EventData) =>
    overlays
      .get(event.id)
      ?.some(
        (item) => [5, 9005].includes(item.kind) && item.pubkey === event.pubkey,
      );
  const rows: RetainedChannelEvidence[number][] = [];
  for (const event of events) {
    if (
      ![9, 40002].includes(event.kind) ||
      !key.test(event.id) ||
      !key.test(event.pubkey) ||
      !Number.isSafeInteger(event.created_at) ||
      event.created_at < 0 ||
      event.created_at > 8_640_000_000_000 ||
      deleted(event)
    )
      continue;
    let edit: EventData | undefined;
    for (const candidate of overlays.get(event.id) ?? []) {
      if (
        candidate.kind === 40003 &&
        candidate.pubkey === event.pubkey &&
        !deleted(candidate)
      )
        edit = newer(edit, candidate);
    }
    let content = edit?.content ?? event.content;
    if (event.kind === 40002) {
      const body = objectBody(content);
      if (typeof body?.content === "string") content = body.content;
    }
    const summary = summaries.get(event.id);
    const participants = summary && objectBody(summary.content)?.participants;
    const presentation = sessionRootPresentation(event);
    rows.push(
      Object.freeze({
        id: event.id,
        channelId,
        authorId: event.pubkey,
        createdAt: event.created_at,
        // Bound before normalization too: no multi-MiB string survives in this DTO.
        excerpt: content.slice(0, 160).trim().replace(/\s+/g, " "),
        titleSource: content.slice(0, 161),
        mentionReferences: identities(
          event.tags.flatMap(([name, value]) =>
            name === "mention" ? [value] : [],
          ),
        ),
        threadRootId: threadReference(event)?.rootId,
        edited: !!edit,
        quietSession: presentation === "quiet",
        chipSession: presentation === "chip",
        mentions: identities(
          event.tags.flatMap(([name, value]) => (name === "p" ? [value] : [])),
        ),
        participants: identities(
          Array.isArray(participants) ? participants : [],
        ),
      }),
    );
  }
  return rows;
}
