import type { ChannelSummary } from "./contracts.ts";

/** Participant-set policy shared by the app and the existing browser broker. */
export function validDirectMessageParticipants(
  pubkeys: readonly string[],
  viewer: string,
): boolean {
  return (
    pubkeys.length >= 1 &&
    pubkeys.length <= 8 &&
    new Set(pubkeys).size === pubkeys.length &&
    pubkeys.every((key) => /^[0-9a-f]{64}$/.test(key) && key !== viewer)
  );
}

/** The usable DM holding exactly the viewer and `pubkeys`: the most recently
 * active, so a new message joins the discussion its author is shown. */
export function directMessageWith(
  channels: readonly ChannelSummary[],
  viewer: string | undefined,
  pubkeys: readonly string[],
): ChannelSummary | undefined {
  if (!viewer || !pubkeys.length) return undefined;
  const members = new Set([viewer, ...pubkeys]);
  let match: ChannelSummary | undefined;
  for (const channel of channels) {
    if (
      channel.channelType !== "dm" ||
      channel.archived ||
      channel.cached ||
      channel.readOnly ||
      channel.pending ||
      channel.huddle ||
      channel.members?.length !== members.size ||
      !channel.members.every((member) => members.has(member))
    )
      continue;
    const activity = channel.lastActivityAt ?? 0;
    const latest = match?.lastActivityAt ?? 0;
    if (
      !match ||
      activity > latest ||
      (activity === latest && channel.id.localeCompare(match.id) < 0)
    )
      match = channel;
  }
  return match;
}
