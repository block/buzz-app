import { useId, useState } from "react";
import type { InboxReaction } from "../../features/relay/inbox-reactions";
import { groupReactions } from "../../features/relay/fold";
import { useReactionEmoji } from "../../features/messages/reaction-emoji";
import { useReactionName } from "../../features/messages/use-reaction-name";
import { isReactionShortcode } from "../../features/relay/emoji";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import type { ComponentProps, ReactNode } from "react";
import { channelIcon, channelText } from "../../features/channels/channel-icon";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import { hasUnread, type InboxItem } from "../../features/relay/inbox";
import type { InboxFeedSnapshot } from "../../features/relay/inbox-feed";
import type { RelaySession } from "../../features/relay/session";
import { workflowLabel } from "../../features/relay/workflow-attribution";
import { messagePreview } from "../../features/notifications/content";
import { ByteLru } from "../../features/relay/budget";
import { avatarMedia } from "../../shared/avatar-source";
import {
  CornerDownRightIcon,
  LightningIcon,
  SmileyIcon,
} from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import type { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { formatPublicKey } from "../../shared/identity/public-key";
import { dmLabel } from "./dm-label";
import styles from "./Inbox.module.css";
import { MessageListRow } from "../../features/messages/MessageListRow";
import { PreviewText } from "../../features/messages/PreviewText";
import type { OwnActivity } from "./own-activity";

type ResolveName = (
  key: string,
  fallback: string,
  candidates?: readonly string[],
) => string;

/** Row previews by message text, least recently used dropped first. Each
 * preview parses Markdown, and every filter change or live event renders all
 * rows again, remounting rows a filter hid. The budget counts the source
 * text, which is the key. */
const previews = new ByteLru<string>(500, 1024 * 1024);
const rowPreview = (content: string) => {
  let text = previews.get(content);
  if (text === undefined) {
    text = messagePreview(content);
    previews.set(content, text, content.length);
  }
  return text;
};

export { hasUnread };

/** What a preview shows instead of a body whose stored edits or deletions are
 * not settled yet, or undefined when none of `ids` is incomplete. */
export const incompletePreview = (
  feed: InboxFeedSnapshot,
  ids: readonly (string | undefined)[],
) =>
  ids.some((id) => id !== undefined && feed.incomplete.includes(id))
    ? feed.status === "error"
      ? "Preview unavailable. Retry activity."
      : "Preview updating…"
    : undefined;

/** Where a DM row's message is: plain "DM" when `sender`, whom the row
 * already names, is the DM's only other member; otherwise "DM", `join` and
 * the DM's names. Compares keys, since two people can share a name. */
function dmContext(
  channel: ChannelSummary,
  sender: string | undefined,
  join: string,
  profiles: ReadonlyMap<string, Profile>,
  name: ResolveName,
) {
  return channel.participants?.length === 1 &&
    channel.participants[0] === sender
    ? "DM"
    : `DM${join}${dmLabel(channel.participants, profiles, name, channel.name ?? "Direct message")}`;
}

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
      ? dmContext(
          channel,
          // A workflow's row names its owner, not the key that signed it.
          item.workflowOwnerId ? undefined : item.authorId,
          " · ",
          profiles,
          name,
        )
      : channel
        ? channelText(channel)
        : "Conversation";
  return { sender, context, profile, channel };
}

/** Profiles a row names: its sender or workflow owner and up to three DM participants. */
export const rowProfileIds = (
  item: Pick<InboxItem, "workflowOwnerId">,
  channel: ChannelSummary | undefined,
): string[] => [
  ...(item.workflowOwnerId ? [item.workflowOwnerId] : []),
  ...(channel?.channelType === "dm"
    ? (channel.participants?.slice(0, 3) ?? [])
    : []),
];

/** Where a row's message is, led by the icon its conversation has in the
 * sidebar: a thread's reply arrow, else the channel's own icon. The icon
 * replaces the text "#", so names read the same for every kind. */
export function RowPlace({
  channel,
  context,
  thread,
}: {
  channel: ChannelSummary | undefined;
  context: string;
  thread: boolean;
}) {
  const Icon = thread ? CornerDownRightIcon : channelIcon(channel);
  return (
    <span className={styles.place}>
      <Icon size={12} aria-hidden="true" className={styles.placeIcon} />
      <span className={styles.placeName}>
        {channel && channel.channelType !== "dm" ? channel.name : context}
      </span>
    </span>
  );
}

/** Who a row of your own message names: you, where you wrote it, and your
 * profile for the avatar. */
export function ownIdentity(
  viewer: string,
  channel: ChannelSummary | undefined,
  profiles: ReadonlyMap<string, Profile>,
  name: ResolveName,
): ReturnType<typeof rowIdentity> {
  const context =
    channel?.channelType === "dm"
      ? dmContext(channel, undefined, " · ", profiles, name)
      : channel
        ? channelText(channel)
        : "Conversation";
  return { sender: "You", context, profile: profiles.get(viewer), channel };
}

/** One Inbox conversation row's button: avatar, sender, source, time, preview
 * and unread mark. With `own`, the row shows your newer message instead; your
 * messages never mark it unread. */
export function InboxRowButton({
  item,
  own,
  identity: { sender, context, profile, channel },
  session,
  feed,
  time,
  previewId,
  ...props
}: (
  | { item: InboxItem; own?: OwnActivity | undefined }
  | { item?: undefined; own: OwnActivity }
) & {
  identity: ReturnType<typeof rowIdentity>;
  session: RelaySession;
  feed: InboxFeedSnapshot;
  time: ReactNode;
  previewId?: string | undefined;
} & Omit<
    ComponentProps<typeof NavigationItem>,
    "icon" | "label" | "trailing" | "aria-label"
  >) {
  const unread = !!item && hasUnread(item);
  const workflow = own ? undefined : item?.workflowOwnerId;
  const createdAt = own?.createdAt ?? item?.createdAt ?? 0;
  return (
    <MessageListRow
      {...props}
      aria-label={
        own ? `Open your message in ${context}` : `Open ${sender} in ${context}`
      }
      aria-describedby={previewId}
      avatar={
        <Avatar
          size="fill"
          alt=""
          fallback={sender}
          fallbackContent={workflow ? <LightningIcon size={20} /> : undefined}
          src={
            workflow ? undefined : avatarMedia(profile?.picture, session.media)
          }
          shape={workflow || profile?.isAgent ? "squircle" : "circle"}
        />
      }
      sender={sender}
      source={
        <RowPlace
          channel={channel}
          context={context}
          thread={!!(own ? own.rootId : item?.thread || item?.rootId)}
        />
      }
      time={
        <time dateTime={new Date(createdAt * 1000).toISOString()}>{time}</time>
      }
      unread={unread}
      previewId={previewId}
      preview={
        own ? (
          <PreviewText
            text={rowPreview(own.preview.content)}
            mentions={own.preview}
            session={session}
            channelId={own.channelId}
          />
        ) : item ? (
          (incompletePreview(feed, [
            item.previewMessageId,
            ...item.messageIds,
          ]) ?? (
            <PreviewText
              text={rowPreview(item.preview)}
              mentions={item.previewMentions}
              session={session}
              channelId={item.channelId}
            />
          ))
        ) : null
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
  time = relativeTimestamp(item.createdAt),
  ...props
}: {
  item: InboxReaction;
  time?: ReactNode;
  session: RelaySession;
  profiles: ReadonlyMap<string, Profile>;
  name: ResolveName;
  channel: ChannelSummary | undefined;
} & Pick<ComponentProps<typeof NavigationItem>, "selected" | "onClick">) {
  const reactionName = useReactionName();
  // Its name reads the preview as shown, with mention chips' labels.
  const nameId = useId();
  const previewId = `${nameId}-preview`;
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
      ? dmContext(
          channel,
          authors.length === 1 ? authors[0] : undefined,
          " with ",
          profiles,
          name,
        )
      : channel
        ? channelText(channel)
        : "Conversation";
  const reactions = groupReactions(item.events);
  const preview = rowPreview(item.message.content);
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
    <MessageListRow
      {...props}
      aria-labelledby={`${nameId} ${previewId}`}
      avatar={
        <Avatar
          size="fill"
          alt=""
          fallback={sender}
          src={avatarMedia(profile?.picture, session.media)}
          shape={profile?.isAgent ? "squircle" : "circle"}
        />
      }
      sender={
        <>
          <span id={nameId} hidden>
            {`${sender} reacted with ${emojiNames} to your message:`}
          </span>
          {sender}
        </>
      }
      source={
        <RowPlace
          channel={channel}
          context={context}
          thread={!!item.message.threadRootId}
        />
      }
      time={
        <time dateTime={new Date(item.createdAt * 1000).toISOString()}>
          {time}
        </time>
      }
      previewId={previewId}
      preview={
        <>
          {reactions.map((reaction) => (
            <ActivityReactionGlyph
              key={JSON.stringify([reaction.content, reaction.emoji?.url])}
              reaction={reaction}
              session={session}
            />
          ))}{" "}
          <PreviewText
            text={preview}
            mentions={item.message}
            session={session}
            channelId={item.message.channelId}
          />
        </>
      }
    />
  );
}

function ActivityReactionGlyph({
  reaction,
  session,
}: {
  reaction: ReturnType<typeof groupReactions>[number];
  session: RelaySession;
}) {
  const emoji = useReactionEmoji(reaction, session);
  const source = emoji ? session.media(emoji.url) : undefined;
  const [failed, setFailed] = useState<string>();
  if (source && source !== failed)
    return (
      <img
        src={source}
        className={styles.reactionEmoji}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setFailed(source)}
      />
    );
  if (isReactionShortcode(reaction.content))
    return (
      <SmileyIcon
        className={`${styles.reactionEmoji} ${styles.reactionPlaceholder}`}
      />
    );
  return <span aria-hidden="true">{reaction.content} </span>;
}
