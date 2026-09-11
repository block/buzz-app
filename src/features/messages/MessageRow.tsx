import { memo } from "react";
import { messageParts } from "../relay/emoji";
import { InlineText } from "../conversation/InlineText";
import type { ConversationExtensions } from "../conversation/contracts";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { DeliveryNotice } from "./DeliveryNotice";
import styles from "./Messages.module.css";
import { isEmojiOnly } from "./emoji-size";

export type MessageRowProps = {
  row: ChannelMessage;
  extensions?: ConversationExtensions | undefined;
  profile: Profile | undefined;
  participantProfiles?: ReadonlyMap<string, Profile>;
  media(url: string): string | undefined;
  onOpenLink(url: string): boolean;
  day: boolean;
  retry: ((id: string) => void) | undefined;
  onOpenThread?: ((messageId: string) => void) | undefined;
};

export const MessageRow = memo(function MessageRow({
  row,
  extensions,
  profile,
  media,
  onOpenLink,
  day,
  retry,
  onOpenThread,
  participantProfiles,
}: MessageRowProps) {
  const name = profile?.name ?? row.authorId.slice(0, 10);
  const picture = profile?.picture ? media(profile.picture) : undefined;
  const emojiOnly = isEmojiOnly(row.content, row.emoji);
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
          <p className={styles.text} data-single-emoji={emojiOnly || undefined}>
            <MessageText
              row={row}
              extensions={extensions}
              media={media}
              onOpenLink={onOpenLink}
            />
          </p>
          <DeliveryNotice row={row} retry={retry} />
          {row.attachments.map((attachment) => {
            const source = media(attachment.url);
            return attachment.video || !source ? (
              <a
                className={styles.attachment}
                key={attachment.url}
                href={attachment.url}
                target="_blank"
                rel="noreferrer"
              >
                {attachment.video ? "Video attachment" : "Image attachment"} ↗
              </a>
            ) : (
              <a
                className={styles.attachmentImage}
                key={attachment.url}
                href={attachment.url}
                target="_blank"
                rel="noreferrer"
                aria-label="Open image attachment"
                onClick={(event) => {
                  if (
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    onOpenLink(attachment.url)
                  )
                    event.preventDefault();
                }}
              >
                <img src={source} alt="" loading="lazy" />
              </a>
            );
          })}
          {row.reactions.length > 0 && (
            <div className={styles.reactions}>
              {row.reactions.map((reaction) => (
                <span key={JSON.stringify(reaction)}>
                  {extensions ? (
                    <InlineText
                      registry={extensions.inline}
                      content={{
                        text: reaction.content,
                        message: row,
                        reaction,
                      }}
                      media={media}
                    />
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
  row,
  extensions,
  media,
  onOpenLink,
}: Pick<MessageRowProps, "row" | "extensions" | "media" | "onOpenLink">) {
  return messageParts(row.content).map((part, index) => {
    const key = `${index}:${part.slice(0, 20)}`;
    if (!part.startsWith("https://")) {
      return (
        <span key={key}>
          {extensions ? (
            <InlineText
              registry={extensions.inline}
              content={{ text: part, message: row }}
              media={media}
            />
          ) : (
            part
          )}
        </span>
      );
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
