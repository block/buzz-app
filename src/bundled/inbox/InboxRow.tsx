import { useMemo, useState } from "react";
import type { InboxReaction } from "../../features/relay/inbox-reactions";
import { groupReactions } from "../../features/relay/fold";
import { useReactionName } from "../../features/messages/use-reaction-name";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import type { ComponentProps, ReactNode } from "react";
import { channelText } from "../../features/channels/channel-icon";
import type {
  ChannelMessage,
  ChannelSummary,
  Profile,
} from "../../features/relay/contracts";
import type { InboxItem } from "../../features/relay/inbox";
import type { InboxFeedSnapshot } from "../../features/relay/inbox-feed";
import type { RelaySession } from "../../features/relay/session";
import { workflowLabel } from "../../features/relay/workflow-attribution";
import { PLAIN_TEXT_LIMIT } from "../../features/notifications/content";
import {
  MessagePreview,
  plainPreview,
} from "../../features/messages/MessagePreview";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { avatarMedia } from "../../shared/avatar-source";
import { LightningIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { formatPublicKey } from "../../shared/identity/public-key";
import { dmLabel } from "./dm-label";
import styles from "./Inbox.module.css";
import rowStyles from "../../features/messages/MessageListRow.module.css";
import { MessageListRow } from "../../features/messages/MessageListRow";

type ResolveName = (
  key: string,
  fallback: string,
  candidates?: readonly string[],
) => string;

export const hasUnread = (item: InboxItem) =>
  item.unreadCount > 0 || item.manual;

/** Who sent a row and where, as the Inbox page and its sidebar preview name it. */
export function rowIdentity(
  item: InboxItem,
  channel: ChannelSummary | undefined,
  profiles: ReadonlyMap<string, Profile>,
  name: ResolveName,
) {
  const displayId = item.workflowOwnerId ?? item.authorId;
  const profile = profiles.get(displayId);
  const resolved = name(
    displayId,
    profile?.name ?? formatPublicKey(displayId) ?? "Unknown sender",
    channel?.members,
  );
  const sender = item.workflowOwnerId ? workflowLabel(resolved) : resolved;
  const context =
    channel?.channelType === "dm"
      ? `DM · ${dmLabel(channel.participants, profiles, name, channel.name ?? "Direct message")}`
      : channel
        ? channelText(channel)
        : "Conversation";
  return { sender, context, profile };
}

/** Profiles a row names: its sender or workflow owner, the people its preview
 * mentions, and up to three DM participants. */
export const rowProfileIds = (
  item: Readonly<{
    workflowOwnerId?: string | undefined;
    previewBody?:
      | Pick<ChannelMessage, "mentions" | "mentionReferences">
      | undefined;
  }>,
  channel: ChannelSummary | undefined,
): string[] => [
  ...(item.workflowOwnerId ? [item.workflowOwnerId] : []),
  ...(item.previewBody?.mentions ?? []),
  ...(item.previewBody?.mentionReferences ?? []),
  ...(channel?.channelType === "dm"
    ? (channel.participants?.slice(0, 3) ?? [])
    : []),
];

/** One Inbox conversation row's button: avatar, sender, source, time, preview and unread mark. */
export function InboxRowButton({
  item,
  identity: { sender, context, profile },
  session,
  extensions,
  feed,
  time,
  previewId,
  ...props
}: {
  item: InboxItem;
  identity: ReturnType<typeof rowIdentity>;
  session: RelaySession;
  extensions?: ConversationExtensions | undefined;
  feed: InboxFeedSnapshot;
  time: ReactNode;
  previewId?: string | undefined;
} & Omit<
  ComponentProps<typeof NavigationItem>,
  "icon" | "label" | "trailing" | "aria-label"
>) {
  const unread = hasUnread(item);
  const status = [item.previewMessageId, ...item.messageIds].some(
    (id) => id !== undefined && feed.incomplete.includes(id),
  )
    ? feed.status === "error"
      ? "Preview unavailable. Retry activity."
      : "Preview updating…"
    : undefined;
  const row = useMemo(() => previewRow(item), [item]);
  // The clamp is visual: a long body describes the row by its bounded text.
  const bounded = useMemo(
    () =>
      previewId && !status && item.preview.length > PLAIN_TEXT_LIMIT
        ? plainPreview(row)
        : undefined,
    [previewId, status, item.preview, row],
  );
  const preview = (
    <MessagePreview row={row} session={session} extensions={extensions} />
  );
  return (
    <MessageListRow
      {...props}
      aria-label={`Open ${sender} in ${context}`}
      aria-describedby={previewId}
      avatar={
        <Avatar
          size="fill"
          alt=""
          fallback={sender}
          fallbackContent={
            item.workflowOwnerId ? <LightningIcon size={20} /> : undefined
          }
          src={
            item.workflowOwnerId
              ? undefined
              : avatarMedia(profile?.picture, session.media)
          }
          shape={
            item.workflowOwnerId || profile?.isAgent ? "squircle" : "circle"
          }
        />
      }
      sender={sender}
      source={context}
      time={
        <time dateTime={new Date(item.createdAt * 1000).toISOString()}>
          {time}
        </time>
      }
      unread={unread}
      previewId={bounded ? undefined : previewId}
      preview={
        status ??
        (bounded ? (
          <>
            <span aria-hidden="true">{preview}</span>
            <span id={previewId} className="sr-only">
              {bounded}
            </span>
          </>
        ) : (
          preview
        ))
      }
    />
  );
}

/** Reaction activity is context, never an unread conversation or a read action. */
export function ReactionRowButton({
  item,
  session,
  profiles,
  name,
  channel,
  extensions,
  time = relativeTimestamp(item.createdAt),
  ...props
}: {
  item: InboxReaction;
  time?: ReactNode;
  session: RelaySession;
  extensions?: ConversationExtensions | undefined;
  profiles: ReadonlyMap<string, Profile>;
  name: ResolveName;
  channel: ChannelSummary | undefined;
} & Pick<ComponentProps<typeof NavigationItem>, "selected" | "onClick">) {
  const reactionName = useReactionName();
  const authors = [...new Set(item.events.map((event) => event.pubkey))];
  const names = authors
    .slice(0, authors.length === 3 ? 3 : 2)
    .map((id) =>
      name(
        id,
        profiles.get(id)?.name ?? formatPublicKey(id) ?? "Someone",
        channel?.members,
      ),
    );
  const sender =
    authors.length > 3
      ? `${names.join(", ")} and ${authors.length - 2} others`
      : authors.length === 3
        ? `${names[0]}, ${names[1]} and ${names[2]}`
        : names.join(" and ");
  const profile = profiles.get(authors[0] ?? "");
  const context =
    channel?.channelType === "dm"
      ? `DM with ${dmLabel(channel.participants, profiles, name, channel.name ?? "Direct message")}`
      : channel
        ? channelText(channel)
        : "Conversation";
  const reactions = groupReactions(item.events);
  const preview = useMemo(() => plainPreview(item.message), [item.message]);
  const emojiNames = reactions
    .map((reaction) =>
      reaction.emoji
        ? `:${reaction.emoji.shortcode}:`
        : (reactionName?.(reaction.content) ?? reaction.content)
            .replaceAll(":", "")
            .replaceAll("_", " "),
    )
    .join(", ");
  return (
    <NavigationItem
      {...props}
      aria-label={`${sender} reacted with ${emojiNames} to your message: ${preview}`}
      icon={
        <Avatar
          size="default"
          alt=""
          fallback={sender}
          src={avatarMedia(profile?.picture, session.media)}
          shape={profile?.isAgent ? "squircle" : "circle"}
        />
      }
      trailing={<span className={rowStyles.unreadSlot} aria-hidden="true" />}
      label={
        <span className={rowStyles.content}>
          <span className={rowStyles.heading}>
            <span className={rowStyles.identity}>
              <span className={styles.reactionHeading}>
                <strong
                  className={`text-label-sm text-standard ${rowStyles.sender}`}
                >
                  {sender}
                </strong>
                <span
                  className={`text-body-sm text-standard ${styles.reactionTail}`}
                >
                  {"\u00a0reacted "}
                  {reactions.map((reaction) => (
                    <ActivityReactionGlyph
                      key={JSON.stringify([
                        reaction.content,
                        reaction.emoji?.url,
                      ])}
                      reaction={reaction}
                      session={session}
                    />
                  ))}
                </span>
              </span>
            </span>
            <time
              data-inbox-date=""
              className={`text-caption text-subtle ${rowStyles.rowDate}`}
              dateTime={new Date(item.createdAt * 1000).toISOString()}
            >
              {time}
            </time>
          </span>
          <span className={`text-body text-subtle ${styles.reactionPreview}`}>
            <MessagePreview
              row={item.message}
              session={session}
              extensions={extensions}
            />
          </span>
          <span className={`text-caption ${rowStyles.source}`}>
            in {context}
          </span>
        </span>
      }
    />
  );
}
/** The shown message as a renderable row: its body and signed display bindings. */
const previewRow = (item: InboxItem): ChannelMessage => ({
  id: item.previewMessageId ?? item.messageId,
  channelId: item.channelId,
  authorId: item.authorId,
  createdAt: item.createdAt,
  content: item.preview,
  mentions: [],
  attachments: [],
  ...item.previewBody,
  participants: [],
  reactions: [],
  replyCount: 0,
});

function ActivityReactionGlyph({
  reaction,
  session,
}: {
  reaction: ReturnType<typeof groupReactions>[number];
  session: RelaySession;
}) {
  const source = reaction.emoji ? session.media(reaction.emoji.url) : undefined;
  const [failed, setFailed] = useState<string>();
  return source && source !== failed ? (
    <img
      src={source}
      className={styles.reactionEmoji}
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={() => setFailed(source)}
    />
  ) : (
    <span aria-hidden="true">{reaction.content} </span>
  );
}
