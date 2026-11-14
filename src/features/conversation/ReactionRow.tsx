import { useState, type ComponentProps, type ReactNode } from "react";
import type { InboxReaction } from "../relay/inbox-reactions";
import { groupReactions } from "../relay/fold";
import type { ChannelSummary, Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { useReactionName } from "../messages/use-reaction-name";
import rowStyles from "../messages/MessageListRow.module.css";
import { channelText } from "../channels/channel-icon";
import { messagePreview } from "../notifications/content";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { avatarMedia } from "../../shared/avatar-source";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { formatPublicKey } from "../../shared/identity/public-key";
import { dmLabel } from "./dm-label";
import styles from "./ReactionRow.module.css";

type ResolveName = (
  key: string,
  fallback: string,
  candidates?: readonly string[],
) => string;

/** Reaction activity is context, never an unread conversation or a read action. */
export function ReactionRow({
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
  const preview = messagePreview(item.message.content);
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
              <span className={styles.heading}>
                <strong
                  className={`text-label-sm text-standard ${rowStyles.sender}`}
                >
                  {sender}
                </strong>
                <span className={`text-body-sm text-standard ${styles.tail}`}>
                  {"\u00a0reacted "}
                  {reactions.map((reaction) => (
                    <ReactionGlyph
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
          <span className={`text-body text-subtle ${styles.preview}`}>
            {preview}
          </span>
          <span className={`text-caption ${rowStyles.source}`}>
            in {context}
          </span>
        </span>
      }
    />
  );
}
function ReactionGlyph({
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
      className={styles.emoji}
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={() => setFailed(source)}
    />
  ) : (
    <span aria-hidden="true">{reaction.content} </span>
  );
}
