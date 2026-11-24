import { useMemo } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { InboxItem } from "../../features/relay/inbox";
import type { RelaySession } from "../../features/relay/session";
import type { PreviewMentions } from "../../features/messages/PreviewText";
import { sentEntries, type ReadEvent } from "../../features/drafts-sent/model";
import { useSent } from "../../features/drafts-sent/views";

/** Your newest message in one Activity conversation. */
export type OwnActivity = Readonly<{
  /** The conversation's Activity id, as `InboxItem.id` names it. */
  id: string;
  channelId: string;
  messageId: string;
  rootId?: string;
  createdAt: number;
  preview: PreviewMentions;
}>;

/**
 * The Activity conversation a message of yours belongs to, by the rule Activity
 * groups everyone else's: a DM is one conversation, a Solo chat's top level is
 * one, and elsewhere each thread, or each top-level message, is its own.
 */
const conversationId = (
  channel: ChannelSummary,
  messageId: string,
  rootId: string | undefined,
) =>
  `${channel.id}:${
    channel.channelType === "dm" ||
    (channel.channelType === "solo" && rootId === undefined)
      ? channel.id
      : (rootId ?? messageId)
  }`;

/** Your newest message in each conversation you can still open, by Activity id. */
export function ownActivity(
  events: readonly ReadEvent[],
  viewer: string,
  channels: readonly ChannelSummary[],
): ReadonlyMap<string, OwnActivity> {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const tags = new Map(events.map((event) => [event.id, event.tags]));
  const latest = new Map<string, OwnActivity>();
  // Newest first, so each conversation keeps the first message it meets.
  for (const entry of sentEntries(events, viewer)) {
    const channel = byId.get(entry.channelId);
    if (
      !channel ||
      channel.archived ||
      channel.huddle ||
      channel.metadataPending ||
      entry.createdAt === undefined
    )
      continue;
    const id = conversationId(channel, entry.id, entry.threadRootId);
    if (latest.has(id)) continue;
    latest.set(id, {
      id,
      channelId: entry.channelId,
      messageId: entry.id,
      ...(entry.threadRootId ? { rootId: entry.threadRootId } : {}),
      createdAt: entry.createdAt,
      preview: {
        content: entry.text,
        mentions: (tags.get(entry.id) ?? []).flatMap(([name, value]) =>
          name === "p" && value ? [value] : [],
        ),
      },
    });
  }
  return latest;
}

/** Your recent messages, read the way Drafts & sent reads them. */
export function useOwnActivity(
  session: RelaySession,
  viewer: string,
  channels: readonly ChannelSummary[],
) {
  const { sent } = useSent(session, viewer);
  return useMemo(
    () => ownActivity(sent.events, viewer, channels),
    [sent.events, viewer, channels],
  );
}

/**
 * One Activity row: a conversation with someone else's message, with yours
 * when it is newer, or a conversation where only you have written lately.
 */
export type OwnRow =
  | Readonly<{
      kind: "conversation";
      item: InboxItem;
      own?: OwnActivity;
      createdAt: number;
    }>
  | Readonly<{ kind: "own"; own: OwnActivity; createdAt: number }>;

/**
 * Activity's conversations ordered by their newest message from anyone, yours
 * included. Your messages never make a conversation unread. `includeOwnOnly`
 * adds conversations where nobody else has written: none of `all`, Activity's
 * every conversation before its filters, holds them.
 */
export function withOwnActivity(
  items: readonly InboxItem[],
  all: readonly InboxItem[],
  own: ReadonlyMap<string, OwnActivity>,
  includeOwnOnly: (own: OwnActivity) => boolean,
): OwnRow[] {
  const listed = new Set(all.map((item) => item.id));
  return [
    ...items.map((item): OwnRow => {
      const mine = own.get(item.id);
      return mine && mine.createdAt >= item.createdAt
        ? { kind: "conversation", item, own: mine, createdAt: mine.createdAt }
        : { kind: "conversation", item, createdAt: item.createdAt };
    }),
    ...[...own.values()]
      .filter((mine) => !listed.has(mine.id) && includeOwnOnly(mine))
      .map(
        (mine): OwnRow => ({
          kind: "own",
          own: mine,
          createdAt: mine.createdAt,
        }),
      ),
  ];
}
