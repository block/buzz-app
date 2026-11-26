import type { EventData } from "../relay/events";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const prefix = "Buzz Huddle (buzz.huddles/v1)\nparent:";
export const huddleDescription = (parent: string) => `${prefix}${parent}`;
export function huddleRoomMetadata(
  description: string | undefined,
  transcriptTag?: string,
) {
  if (!description?.startsWith(prefix)) return;
  const [parent, previewOrigin, ...extra] = description
    .slice(prefix.length)
    .split("\n");
  if (!parent || !uuid.test(parent) || extra.length) return;
  const origin = transcriptTag ?? previewOrigin;
  if (origin === undefined) return { parent };
  if (origin === "transcripts:channel")
    return { parent, transcriptDestination: { channelId: parent } };
  const card = /^transcripts:card:([0-9a-f]{64}):([0-9a-f]{64})$/.exec(origin);
  if (card?.[1] && card[2])
    return {
      parent,
      transcriptDestination: {
        channelId: parent,
        root: card[1],
        parentId: card[2],
      },
    };
  const root = /^transcripts:thread:([0-9a-f]{64})$/.exec(origin)?.[1];
  if (root)
    return { parent, transcriptDestination: { channelId: parent, root } };
}
export const huddleParent = (description: string | undefined) =>
  huddleRoomMetadata(description)?.parent;
export const isHuddleRoom = (description: string | undefined) =>
  huddleParent(description) !== undefined;
export function huddleLifecycleBody(event: Pick<EventData, "content">) {
  try {
    return JSON.parse(event.content) as {
      ephemeral_channel_id?: unknown;
      transcripts_in_origin?: unknown;
      thread_root?: unknown;
      card_id?: unknown;
    } | null;
  } catch {
    return undefined;
  }
}
export function huddleCardRoom(event: Pick<EventData, "kind" | "tags">) {
  if (event.kind !== 9) return;
  const room = event.tags.find(([key]) => key === "buzz:huddle-card")?.[1];
  return room && uuid.test(room) ? room : undefined;
}
export function huddleRoom(event: Pick<EventData, "content">) {
  const id = huddleLifecycleBody(event)?.ephemeral_channel_id;
  return typeof id === "string" && uuid.test(id) ? id : undefined;
}
/** Relay-signed participation is display evidence, never permission to join. */
export function huddleLifecycle(
  events: readonly EventData[],
  room: string,
  parent: string,
  authority?: string,
) {
  const scoped = events.filter(
    (e) =>
      huddleRoom(e) === room &&
      e.tags.some((t) => t[0] === "h" && t[1] === parent),
  );
  const start = scoped
    .filter((e) => e.kind === 48100)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0];
  const participants = new Set<string>();
  let endedAt: number | undefined;
  for (const event of scoped.sort(
    (a, b) =>
      a.created_at - b.created_at ||
      a.kind - b.kind ||
      a.id.localeCompare(b.id),
  )) {
    if (start && event.created_at < start.created_at) continue;
    if (
      event.kind === 48103 &&
      (event.pubkey === authority || event.pubkey === start?.pubkey)
    ) {
      endedAt = event.created_at;
    } else if (!endedAt && event.pubkey === authority) {
      const key = event.tags.find((t) => t[0] === "p")?.[1];
      if (!key || !/^[0-9a-f]{64}$/.test(key)) continue;
      if (event.kind === 48101) participants.add(key);
      if (event.kind === 48102) participants.delete(key);
    }
  }
  return {
    startedAt: start?.created_at,
    endedAt,
    participants: [...participants],
  };
}
