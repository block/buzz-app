import { memo } from "react";
import {
  messageParts,
  emojiMatches,
  type CustomEmoji as Emoji,
} from "../relay/emoji";
import { CustomEmoji } from "./CustomEmoji";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { DeliveryNotice } from "./DeliveryNotice";
import styles from "./Messages.module.css";

export const MessageRow = memo(function MessageRow({
  row,
  profile,
  media,
  onOpenLink,
  day,
  retry,
  onOpenThread,
  participantProfiles,
}: {
  row: ChannelMessage;
  profile: Profile | undefined;
  participantProfiles?: ReadonlyMap<string, Profile>;
  media(url: string): string | undefined;
  onOpenLink(url: string): boolean;
  day: boolean;
  retry: ((id: string) => void) | undefined;
  onOpenThread?: ((messageId: string) => void) | undefined;
}) {
  const name = profile?.name ?? row.authorId.slice(0, 10);
  const picture = profile?.picture ? media(profile.picture) : undefined;
  return (
    <div data-message-id={row.id}>
      {day && (
        <div className={styles.day}>
          <span>
            {new Date(row.createdAt * 1000).toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </span>
        </div>
      )}
      <div className={styles.message}>
        <div className={styles.avatar}>
          {picture ? (
            <img src={picture} alt="" loading="lazy" />
          ) : (
            name.slice(0, 2).toUpperCase()
          )}
        </div>
        <div className={styles.messageBody}>
          <div className={styles.byline}>
            <strong>{name}</strong>
            <time dateTime={new Date(row.createdAt * 1000).toISOString()}>
              {new Date(row.createdAt * 1000).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
          </div>
          <p className={styles.text}>
            <MessageText
              content={row.content}
              emoji={row.emoji ?? []}
              media={media}
              onOpenLink={onOpenLink}
            />
          </p>
          <DeliveryNotice row={row} retry={retry} />
          {row.attachments.map((attachment) => (
            <a
              className={styles.attachment}
              key={attachment.url}
              href={attachment.url}
              target="_blank"
              rel="noreferrer"
            >
              {attachment.video ? "Video attachment" : "Image attachment"} ↗
            </a>
          ))}
          {row.reactions.length > 0 && (
            <div className={styles.reactions}>
              {row.reactions.map((reaction) => (
                <span key={JSON.stringify(reaction)}>
                  {reaction.emoji ? (
                    <CustomEmoji emoji={reaction.emoji} media={media} />
                  ) : (
                    reaction.content
                  )}
                </span>
              ))}
            </div>
          )}
          {row.replyCount > 0 && onOpenThread && (
            <button
              type="button"
              className={styles.replies}
              aria-label={`View thread: ${row.replyCount} ${row.replyCount === 1 ? "reply" : "replies"}`}
              onClick={(event) => {
                event.currentTarget.focus();
                onOpenThread(row.id);
              }}
            >
              {row.participants.length > 0 && (
                <span className={styles.threadAvatars} aria-hidden="true">
                  {row.participants.slice(0, 3).map((id) => {
                    const participant = participantProfiles?.get(id);
                    const name = participant?.name ?? id.slice(0, 10);
                    const picture = participant?.picture
                      ? media(participant.picture)
                      : undefined;
                    return (
                      <span
                        key={id}
                        className={styles.threadAvatar}
                        title={name}
                      >
                        {name.slice(0, 2).toUpperCase()}
                        {picture && (
                          <img
                            key={picture}
                            src={picture}
                            alt=""
                            loading="lazy"
                            onError={(event) => {
                              event.currentTarget.hidden = true;
                            }}
                          />
                        )}
                      </span>
                    );
                  })}
                  {row.participants.length > 3 && (
                    <span className={styles.threadAvatar}>
                      +{row.participants.length - 3}
                    </span>
                  )}
                </span>
              )}
              <span>
                {row.replyCount} {row.replyCount === 1 ? "reply" : "replies"}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
function MessageText({
  content,
  emoji,
  media,
  onOpenLink,
}: {
  content: string;
  emoji: readonly Emoji[];
  media(url: string): string | undefined;
  onOpenLink(url: string): boolean;
}) {
  return messageParts(content).map((part, index) => {
    const key = `${index}:${part.slice(0, 20)}`;
    if (!part.startsWith("https://")) {
      const parts = [];
      let offset = 0;
      for (const match of emojiMatches(part, emoji)) {
        parts.push(part.slice(offset, match.start));
        parts.push(
          <CustomEmoji key={match.start} emoji={match.emoji} media={media} />,
        );
        offset = match.end;
      }
      parts.push(part.slice(offset));
      return <span key={key}>{parts}</span>;
    }
    const url = part.replace(/[.,;:!?)\]}]+$/, "");
    return (
      <span key={key}>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            if (
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              onOpenLink(url)
            )
              event.preventDefault();
          }}
        >
          {url}
        </a>
        {part.slice(url.length)}
      </span>
    );
  });
}
