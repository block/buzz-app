import { useId, useState } from "react";
import type { InboxReaction } from "../../features/relay/inbox-reactions";
import { groupReactions } from "../../features/relay/fold";
import { useReactionEmoji } from "../../features/messages/reaction-emoji";
import { useReactionName } from "../../features/messages/use-reaction-name";
import { isReactionShortcode } from "../../features/relay/emoji";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import type { ComponentProps, ReactNode } from "react";
import { channelText } from "../../features/channels/channel-icon";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import {
  senderKey,
  type InboxItem,
  type InboxSender,
} from "../../features/relay/inbox";
import type { InboxFeedSnapshot } from "../../features/relay/inbox-feed";
import type { RelaySession } from "../../features/relay/session";
import { workflowLabel } from "../../features/relay/workflow-attribution";
import { messagePreview } from "../../features/notifications/content";
import { ByteLru } from "../../features/relay/budget";
import { avatarMedia } from "../../shared/avatar-source";
import { LightningIcon, SmileyIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { formatPublicKey } from "../../shared/identity/public-key";
import { dmLabel } from "./dm-label";
import styles from "./Inbox.module.css";
import rowStyles from "../../features/messages/MessageListRow.module.css";
import { MessageListRow } from "../../features/messages/MessageListRow";
import { PreviewText } from "../../features/messages/PreviewText";

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

export const hasUnread = (item: InboxItem) =>
  item.unreadCount > 0 || item.manual;

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

/** Who sent a row and where, as the Inbox page and its sidebar preview name
 * it, with what else is unread there. */
export type RowIdentity = {
  sender: string;
  context: string;
  profile: Profile | undefined;
  more?: MoreUnread | undefined;
};

/** Unread messages a row's preview leaves out: the other senders its
 * avatars show, most messages first, and a sentence with their count that
 * names the same senders. */
type MoreUnread = {
  people: readonly {
    id: string;
    name: string;
    profile?: Profile;
    workflow: boolean;
  }[];
  description: string;
};

/** A sender's name and profile: a workflow by its label and its owner's
 * profile, which names it but never gives it the owner's face. */
function senderName(
  { authorId, workflowOwnerId }: InboxSender,
  channel: ChannelSummary | undefined,
  profiles: ReadonlyMap<string, Profile>,
  name: ResolveName,
) {
  const id = workflowOwnerId ?? authorId;
  const profile = profiles.get(id);
  const resolved = name(
    id,
    profile?.name ?? formatPublicKey(id) ?? "Unknown sender",
    channel?.members,
  );
  return {
    name: workflowOwnerId ? workflowLabel(resolved) : resolved,
    profile,
  };
}

export function rowIdentity(
  item: InboxItem,
  channel: ChannelSummary | undefined,
  profiles: ReadonlyMap<string, Profile>,
  name: ResolveName,
): RowIdentity {
  const { name: sender, profile } = senderName(item, channel, profiles, name);
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
  return {
    sender,
    context,
    profile,
    more: moreUnread(item, channel, profiles, name),
  };
}

/** Senders a row's unread summary shows on its avatar, and names. */
const SUMMARY_PEOPLE = 3;

function moreUnread(
  item: InboxItem,
  channel: ChannelSummary | undefined,
  profiles: ReadonlyMap<string, Profile>,
  name: ResolveName,
): MoreUnread | undefined {
  const more = item.moreUnread;
  if (!more) return;
  // The row already shows its own sender.
  const own = senderKey(item);
  const others = more.senders.filter((sender) => senderKey(sender) !== own);
  const people = others.slice(0, SUMMARY_PEOPLE).map((sender) => {
    const { name: resolved, profile } = senderName(
      sender,
      channel,
      profiles,
      name,
    );
    return {
      id: senderKey(sender),
      name: resolved,
      workflow: !!sender.workflowOwnerId,
      ...(profile ? { profile } : {}),
    };
  });
  const names = people.map((person) => person.name);
  const rest = others.length - people.length;
  if (rest) names.push(`${rest} ${rest === 1 ? "other" : "others"}`);
  const label = `and ${more.count} more ${more.count === 1 ? "message" : "messages"}`;
  return {
    people,
    description: names.length
      ? `${label} from ${new Intl.ListFormat(undefined, { type: "conjunction" }).format(names)}`
      : label,
  };
}

/** Profiles a row names: its sender or workflow owner, the senders its unread
 * summary shows or names (one more, in case one is the row's sender) and up
 * to three DM participants. */
export const rowProfileIds = (
  item: Pick<InboxItem, "workflowOwnerId" | "moreUnread">,
  channel: ChannelSummary | undefined,
): string[] => [
  ...(item.workflowOwnerId ? [item.workflowOwnerId] : []),
  ...(item.moreUnread?.senders
    .slice(0, SUMMARY_PEOPLE + 1)
    .map((sender) => sender.workflowOwnerId ?? sender.authorId) ?? []),
  ...(channel?.channelType === "dm"
    ? (channel.participants?.slice(0, 3) ?? [])
    : []),
];

/** One Inbox conversation row's button: avatar, sender, source, time, preview and unread mark. */
export function InboxRowButton({
  item,
  identity: { sender, context, profile, more },
  session,
  feed,
  time,
  previewId,
  ...props
}: {
  item: InboxItem;
  identity: RowIdentity;
  session: RelaySession;
  feed: InboxFeedSnapshot;
  time: ReactNode;
  previewId?: string | undefined;
} & Omit<
  ComponentProps<typeof NavigationItem>,
  "icon" | "label" | "trailing" | "aria-label"
>) {
  const unread = hasUnread(item);
  const summaryId = useId();
  return (
    <MessageListRow
      {...props}
      aria-label={`Open ${sender} in ${context}`}
      aria-describedby={
        [previewId, more && summaryId].filter(Boolean).join(" ") || undefined
      }
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
      avatarBadge={
        // Mounted while empty too, so faces shrink away as they are read.
        <>
          <AvatarStack
            size="badge"
            max={SUMMARY_PEOPLE}
            animateChanges
            // Later avatars overlap earlier ones, so the sender with the
            // most unread messages renders last: on top, in the corner.
            items={[...(more?.people ?? [])]
              .reverse()
              .map(({ id, name, profile, workflow }) => ({
                id,
                name,
                // A workflow wears its own artwork, as the row's avatar does.
                src: workflow
                  ? undefined
                  : avatarMedia(profile?.picture, session.media),
                ...(workflow && {
                  fallbackContent: <LightningIcon size={9} />,
                }),
                shape: workflow || profile?.isAgent ? "squircle" : "circle",
              }))}
          />
          {more && (
            <span id={summaryId} className="sr-only">
              {more.description}
            </span>
          )}
        </>
      }
      sender={sender}
      source={context}
      time={
        <time dateTime={new Date(item.createdAt * 1000).toISOString()}>
          {time}
        </time>
      }
      unread={unread}
      previewId={previewId}
      preview={
        incompletePreview(feed, [
          item.previewMessageId,
          ...item.messageIds,
        ]) ?? (
          <PreviewText
            text={rowPreview(item.preview)}
            mentions={item.previewMentions}
            session={session}
            channelId={item.channelId}
          />
        )
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
    <NavigationItem
      {...props}
      aria-labelledby={`${nameId} ${previewId}`}
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
          <span id={nameId} hidden>
            {`${sender} reacted with ${emojiNames} to your message:`}
          </span>
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
          <span
            id={previewId}
            className={`text-body text-subtle ${styles.reactionPreview}`}
          >
            <PreviewText
              text={preview}
              mentions={item.message}
              session={session}
              channelId={item.message.channelId}
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
