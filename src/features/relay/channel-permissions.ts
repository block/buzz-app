import type { ChannelSummary } from "./contracts";

export type ChannelAction = "post" | "reply" | "react" | "removeReaction";

/** Narrow Guest grants never turn a channel into a general writable resource. */
export function channelCan(
  channel: ChannelSummary | undefined,
  action: ChannelAction,
): boolean {
  if (!channel || channel.archived || channel.cached) return false;
  if (!channel.readOnly) return true;
  if (
    channel.viewerRole !== "guest" ||
    !["stream", "forum"].includes(channel.channelType ?? "")
  )
    return false;
  return action === "reply"
    ? channel.guestReplies === true
    : action === "react"
      ? channel.guestReactions === true
      : action === "removeReaction";
}
