import type { ChannelMessage, ChannelSummary } from "./contracts";
import type { EventData } from "./events";
import { messageAuthor } from "./fold";
import { threadReference } from "./thread-reference";

/** Channel metadata grants this UI only a preview; the relay decides each write. */
export function publisherReader(channel: ChannelSummary | undefined): boolean {
  return (
    !!channel?.messagePublisher &&
    !channel.archived &&
    !channel.cached &&
    !channel.metadataCached &&
    (channel.visibility === "public" || !!channel.viewerRole)
  );
}

export function canStartMessage(
  channel: ChannelSummary | undefined,
  viewer: string | undefined,
): boolean {
  return (
    !!channel &&
    !channel.archived &&
    (channel.messagePublisher === undefined
      ? !channel.readOnly
      : publisherReader(channel) &&
        !!viewer &&
        channel.messagePublisher === viewer)
  );
}

export function canReplyToPublisher(
  channel: ChannelSummary | undefined,
  root: ChannelMessage | undefined,
): boolean {
  return (
    publisherReader(channel) &&
    !!root &&
    root.channelId === channel?.id &&
    root.authorId === channel.messagePublisher &&
    !root.threadRootId &&
    !root.membership &&
    !root.huddle &&
    !root.diff
  );
}

/** Recheck local evidence at signing/publication; forged or stale events still
 * pass the relay's complete ancestry and access checks before acceptance. */
export function validatePublisherMessage(
  channel: ChannelSummary,
  event: Pick<EventData, "kind" | "tags">,
  viewer: string | undefined,
  find: (id: string) => EventData | undefined,
  authority?: string,
) {
  if (
    channel.messagePublisher === undefined ||
    ![9, 40002, 40003].includes(event.kind)
  )
    return false;
  if (!publisherReader(channel) || !viewer)
    throw new Error("Channel access changed; your draft is kept");
  let original = event;
  if (event.kind === 40003) {
    const target = event.tags.find(([key]) => key === "e")?.[1];
    const found = target ? find(target) : undefined;
    if (
      !found ||
      messageAuthor(found, authority) !== viewer ||
      ![9, 40002].includes(found.kind)
    )
      throw new Error("Only your own eligible message can be edited");
    original = found;
  }
  const publisher = channel.messagePublisher;
  if (
    viewer !== publisher &&
    original.tags.some(([key]) => key === "broadcast")
  )
    throw new Error("Only the channel publisher can send to the channel");
  if (event.kind === 40003 && event.tags.some(([key]) => key === "broadcast"))
    throw new Error("An edit cannot broadcast a message");
  const thread = threadReference(original);
  if (
    !thread &&
    original.tags.some(
      ([key, value, , marker]) =>
        key === "e" && marker === "root" && /^[0-9a-f]{64}$/i.test(value ?? ""),
    )
  )
    throw new Error(
      "Root-only references are unavailable in publisher channels",
    );
  if (!thread) {
    if (viewer !== publisher)
      throw new Error("Open a post by the channel publisher to reply");
    return true;
  }
  const root = find(thread.rootId);
  if (
    !root ||
    ![9, 40002].includes(root.kind) ||
    threadReference(root) ||
    root.tags.some(
      ([key, value, , marker]) =>
        key === "e" && marker === "root" && /^[0-9a-f]{64}$/i.test(value ?? ""),
    ) ||
    !root.tags.some(([key, value]) => key === "h" && value === channel.id) ||
    messageAuthor(root, authority) !== publisher
  )
    throw new Error("Load a post by the channel publisher before replying");
  return true;
}
