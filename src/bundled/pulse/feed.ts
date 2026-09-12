import type {
  ChannelSummary,
  ChannelMessage,
  Profile,
} from "../../features/relay/contracts";
import type { VisibleEvent } from "../../features/relay/projection";
import { foldMessages } from "../../features/relay/fold";

export function visibleChannels(channels: readonly ChannelSummary[]) {
  return channels.filter(
    (channel) =>
      !channel.archived && (!channel.hidden || channel.channelType === "dm"),
  );
}
export function channelLabel(
  channel: ChannelSummary,
  profiles: ReadonlyMap<string, Profile>,
) {
  if (channel.channelType !== "dm" || !channel.participants)
    return channel.name;
  return channel.participants.length
    ? channel.participants
        .map((id) => profiles.get(id)?.name ?? id.slice(0, 10))
        .join(", ")
    : "Notes to self";
}
/** Presentation over an owned host view. No independent retained cache or authority. */
export function pulseRows(
  events: readonly VisibleEvent[],
  channels: readonly ChannelSummary[],
) {
  const usable = events.filter(
    (event) =>
      !([40003, 7].includes(event.kind) && event.delivery === "failed"),
  );
  const byId = new Map(events.map((event) => [event.id, event]));
  return visibleChannels(channels)
    .flatMap((channel) => {
      // The session does not expose the relay signing identity. Do not infer it or
      // trust an arbitrary 39005 author; the shared thread reader resolves replies.
      const rows = foldMessages(channel.id, "", usable);
      return rows.map((row) => ({
        ...row,
        delivery: byId.get(row.id)?.delivery,
        deliveryError: byId.get(row.id)?.error,
      }));
    })
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
export function filterRows(
  rows: readonly ChannelMessage[],
  channels: readonly ChannelSummary[],
  profiles: ReadonlyMap<string, Profile>,
  view: string,
  search: string,
  viewer?: string,
) {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const channel = byId.get(row.channelId);
      if (!channel) return false;
      if (
        view === "for-you" &&
        !(
          channel.channelType === "dm" ||
          (viewer && row.mentions.includes(viewer))
        )
      )
        return false;
      const text = `${row.content} ${channelLabel(channel, profiles)} ${profiles.get(row.authorId)?.name ?? ""}`;
      if (
        view === "search" &&
        !text.toLowerCase().includes(search.trim().toLowerCase())
      )
        return false;
      if (seen.has(row.channelId)) return false;
      seen.add(row.channelId);
      return true;
    })
    .slice(0, 30);
}
