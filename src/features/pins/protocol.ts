import type { EventData } from "../relay/events.ts";

/** A pin: `["h", channel]` and exactly one `["e", message]`, empty content. */
export const PIN_KIND = 40004;
/** Channel owners and admins remove another member's pin with NIP-29 kind 9005. */
export const PIN_REMOVAL_KIND = 9005;
/** Kinds a pins writer signs besides kind 5, which every host already signs. */
export const PIN_KINDS = [PIN_KIND, PIN_REMOVAL_KIND] as const;

const EVENT_ID = /^[0-9a-f]{64}$/;

export type Pin = Readonly<{
  /** The pin event, which unpinning deletes; never the message itself. */
  id: string;
  channelId: string;
  messageId: string;
  pinnedBy: string;
  pinnedAt: number;
}>;
export type PinWrite = Readonly<{
  kind: number;
  content: "";
  tags: string[][];
}>;
export type ChannelRole = "owner" | "admin" | "member" | "guest" | "bot";

const values = (event: EventData, name: string) =>
  event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1] ?? "");

export function parsePin(event: EventData): Pin | undefined {
  if (event.kind !== PIN_KIND || event.content !== "") return undefined;
  const channels = values(event, "h");
  const targets = values(event, "e");
  const [channelId] = channels;
  const [messageId] = targets;
  if (
    channels.length !== 1 ||
    !channelId ||
    targets.length !== 1 ||
    !messageId ||
    !EVENT_ID.test(messageId)
  )
    return undefined;
  return {
    id: event.id,
    channelId,
    messageId,
    pinnedBy: event.pubkey,
    pinnedAt: event.created_at,
  };
}

/** Whether `event` removes `pin`: the pinner's own kind 5, or a kind 9005,
 * which the relay accepts only from a channel owner or admin. */
function removes(event: EventData, pin: Pin) {
  if (event.kind !== 5 && event.kind !== PIN_REMOVAL_KIND) return false;
  if (event.kind === 5 && event.pubkey !== pin.pinnedBy) return false;
  const channels = values(event, "h");
  if (channels.length > 0 && !channels.includes(pin.channelId)) return false;
  return values(event, "e").includes(pin.id);
}

/** The channel's live pins, one per message (the earliest), newest first.
 * Events may repeat or arrive in any order; unrelated kinds are ignored. */
export function foldPins(
  events: readonly EventData[],
  channelId: string,
): readonly Pin[] {
  const unique = [
    ...new Map(events.map((event) => [event.id, event])).values(),
  ];
  const removals = unique.filter(
    (event) => event.kind === 5 || event.kind === PIN_REMOVAL_KIND,
  );
  const byMessage = new Map<string, Pin>();
  for (const event of unique) {
    const pin = parsePin(event);
    if (!pin || pin.channelId !== channelId) continue;
    if (removals.some((removal) => removes(removal, pin))) continue;
    const prior = byMessage.get(pin.messageId);
    if (
      !prior ||
      pin.pinnedAt < prior.pinnedAt ||
      (pin.pinnedAt === prior.pinnedAt && pin.id < prior.id)
    )
      byMessage.set(pin.messageId, pin);
  }
  return [...byMessage.values()].sort(
    (a, b) => b.pinnedAt - a.pinnedAt || (a.id < b.id ? -1 : 1),
  );
}

export function pinWrite(channelId: string, messageId: string): PinWrite {
  return {
    kind: PIN_KIND,
    content: "",
    tags: [
      ["h", channelId],
      ["e", messageId],
    ],
  };
}

/** The pinner deletes their own pin without a trace (kind 5); anyone else
 * removes it as a moderator (kind 9005), which the channel shows. */
export function unpinWrite(pin: Pin, viewer: string): PinWrite {
  return {
    kind: pin.pinnedBy === viewer ? 5 : PIN_REMOVAL_KIND,
    content: "",
    tags: [
      ["h", pin.channelId],
      ["e", pin.id],
      ["k", String(PIN_KIND)],
    ],
  };
}

/** Presentation only; the relay's channel write gate decides. */
export function canPin(role: ChannelRole | undefined) {
  return role !== undefined && role !== "guest";
}

/** Presentation only; the relay decides who may delete a pin. */
export function canUnpin(
  pin: Pin,
  viewer: string | undefined,
  role: ChannelRole | undefined,
) {
  return (
    (!!viewer && pin.pinnedBy === viewer) ||
    role === "owner" ||
    role === "admin"
  );
}
