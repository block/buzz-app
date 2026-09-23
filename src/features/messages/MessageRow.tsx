import { useIdentityNames } from "../identity-names/react";
import { Button } from "../../shared/design-system/ui/Button";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { memo, useCallback, useSyncExternalStore, type ReactNode } from "react";
import { PresenceIndicator } from "../presence/react";
import type { RelaySession } from "../relay/session";
import type { UnreadCapability } from "../relay/unread";
import { MediaAttachment, type MediaPlayback } from "./MediaAttachment";
import { parseMediaTimeReply } from "./media-timecode";
import { profileTarget } from "../profiles/target";
import { InlineText } from "../conversation/InlineText";
import type { ConversationExtensions } from "../conversation/contracts";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { AttachmentImage } from "./AttachmentImage";
import { DeliveryNotice } from "./DeliveryNotice";
import { AudioAttachment } from "./AudioAttachment";
import { FileAttachment, isProxySource } from "./FileAttachment";
import { useReferenceDirectory } from "./ReferenceText";
import { MessageMarkdown } from "./MessageMarkdown";
import { safeMessageUrl } from "../relay/message-content";
import styles from "./Messages.module.css";
import { usesLargeEmojiPresentation } from "./emoji-size";
import { ReactionTool } from "../conversation/ReactionTool";

import { MessageActionBar } from "./MessageActionBar";
import { messageCopyLink, messageCopyText } from "./message-copy";

const emptySubscribe = () => () => {};
const EMPTY_CHANNEL_LIST = Object.freeze({
  status: "unavailable" as const,
  channels: Object.freeze([]),
});
const emptyChannelList = () => EMPTY_CHANNEL_LIST;

export type MessageRowProps = {
  row: ChannelMessage;
  session?: RelaySession | undefined;
  scope?: string | undefined;
  unread?: UnreadCapability | undefined;
  extensions?: ConversationExtensions | undefined;
  profile: Profile | undefined;
  participantProfiles?: ReadonlyMap<string, Profile> | undefined;
  agentPubkeys?: ReadonlySet<string> | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  media(url: string, size?: "small"): string | undefined;
  onOpenLink(url: string): boolean;
  day: boolean;
  retry: ((id: string) => void) | undefined;
  onOpenThread?:
    | ((messageId: string, threadRootId: string, intent?: "reply") => void)
    | undefined;
  onReply?: (() => void) | undefined;
  quickControls?: ReactNode;
  overflowItems?: ReactNode;
  mediaMode?: "inline" | "thread";
  mediaSeekTo?: number;
  mediaSeekRequest?: number;
  onMediaPlayback?: (playback: MediaPlayback) => void;
  onMediaTime?: (seconds: number) => void;
  onOpenMediaReview?: (
    messageId: string,
    attachment: ChannelMessage["attachments"][number],
    seconds: number,
  ) => void;
};

export const MessageRow = memo(function MessageRow({
  row,
  session,
  scope,
  unread,
  extensions,
  profile,
  media,
  onOpenLink,
  canOpenLink,
  day,
  retry,
  onOpenThread,
  onReply,
  quickControls,
  overflowItems,
  participantProfiles,
  mediaMode = "inline",
  mediaSeekTo,
  mediaSeekRequest,
  onMediaPlayback,
  onMediaTime,
  onOpenMediaReview,
  agentPubkeys,
}: MessageRowProps) {
  const resolveName = useIdentityNames(session?.names);
  const directory = useReferenceDirectory(session, participantProfiles);
  const threadUnread = useThreadUnread(
    row.replyCount > 0 && onOpenThread ? unread : undefined,
    row.channelId,
    row.threadRootId ?? row.id,
  );
  const channelList = useSyncExternalStore(
    session?.channels.subscribeList ?? emptySubscribe,
    session?.channels.list ?? emptyChannelList,
    session?.channels.list ?? emptyChannelList,
  );
  const unreadLabel =
    threadUnread?.manual === "local-only"
      ? "Thread marked unread on this device only"
      : threadUnread?.manual === "remote"
        ? "Thread marked unread"
        : (threadUnread?.observedCount ?? 0) > 0
          ? `Observed unread replies${threadUnread?.freshness === "stale" ? "; may be out of date" : ""}. Not an exact total.`
          : undefined;
  const name = resolveName(
    row.authorId,
    profile?.name ?? row.authorId.slice(0, 10),
  );
  const picture = profile?.picture
    ? media(profile.picture, "small")
    : undefined;
  const target = profileTarget(row.authorId);
  const clickable = target && canOpenLink?.(target);
  const avatarShape =
    row.agentEnvelope || agentPubkeys?.has(row.authorId)
      ? "squircle"
      : "circle";
  const timeReply = parseMediaTimeReply(row.content);
  const replaceTime = !!timeReply && !!onMediaTime;
  const displayRow = replaceTime ? { ...row, content: timeReply.content } : row;
  const emojiOnly = usesLargeEmojiPresentation(displayRow.content, row.emoji);
  const canReact = !!(
    extensions &&
    session &&
    scope &&
    session.outbox?.supports(7) &&
    (!session.channels.get ||
      channelList.channels.some((channel) => channel.id === row.channelId)) &&
    !channelList.channels.find((channel) => channel.id === row.channelId)
      ?.archived
  );
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
        {clickable ? (
          <IconButton
            size="large"
            shape="round"
            aria-label={`View ${name} profile`}
            onClick={(event) => {
              event.currentTarget.focus();
              onOpenLink(target);
            }}
            icon={
              <Avatar
                src={picture}
                alt=""
                fallback={name}
                size="fill"
                shape={avatarShape}
              />
            }
          />
        ) : (
          <Avatar
            src={picture}
            alt=""
            fallback={name}
            size="large"
            shape={avatarShape}
          />
        )}
        <div className={styles.messageBody}>
          {!row.membership && (
            <MessageActionBar
              messageId={row.id}
              onReply={
                onReply ??
                (onOpenThread
                  ? () =>
                      onOpenThread(
                        row.threadRootId ?? row.id,
                        row.threadRootId ?? row.id,
                        "reply",
                      )
                  : undefined)
              }
              replyDisabled={
                !!(
                  row.delivery && !["accepted", "seen"].includes(row.delivery)
                ) ||
                !!channelList.channels.find(
                  (channel) => channel.id === row.channelId,
                )?.archived ||
                (!!session?.channels.get &&
                  !channelList.channels.some(
                    (channel) =>
                      channel.id === row.channelId && !channel.readOnly,
                  ))
              }
              link={messageCopyLink(row, scope)}
              copyText={() =>
                messageCopyText(row, directory.profiles, directory.agents)
              }
              quickControls={quickControls}
              overflowItems={overflowItems}
            />
          )}
          <div className={styles.byline}>
            <strong>{name}</strong>
            {session && (
              <PresenceIndicator
                presence={session.presence}
                pubkey={row.authorId}
              />
            )}
            <time dateTime={new Date(row.createdAt * 1000).toISOString()}>
              {new Date(row.createdAt * 1000).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
          </div>
          {timeReply && onMediaTime && (
            <span className={styles.mediaTimeLink}>
              <Button
                size="sm"
                type="button"
                onClick={() => onMediaTime(timeReply.anchor.seconds)}
              >
                {timeReply.label}
              </Button>
            </span>
          )}
          <MessageMarkdown
            directory={directory}
            session={session}
            scope={scope}
            row={displayRow}
            extensions={extensions}
            media={media}
            onOpenLink={onOpenLink}
            canOpenLink={canOpenLink}
            participantProfiles={participantProfiles}
            largeEmoji={emojiOnly}
          />
          <DeliveryNotice row={row} retry={retry} />
          {row.attachments.map((attachment) => {
            const url = safeMessageUrl(attachment.url);
            if (!url) return null;
            const source = media(url);
            if (attachment.kind === "file")
              return (
                <FileAttachment
                  key={url}
                  attachment={{ ...attachment, url }}
                  source={source}
                  onOpenLink={onOpenLink}
                />
              );
            if (attachment.kind === "audio") {
              if (source && isProxySource(source))
                return (
                  <AudioAttachment
                    key={url}
                    attachment={{ ...attachment, url }}
                    source={source}
                  />
                );
              return (
                <FileAttachment
                  key={url}
                  attachment={{ ...attachment, url }}
                  source={source}
                  onOpenLink={onOpenLink}
                />
              );
            }
            if (attachment.kind === "image" && source)
              return (
                <AttachmentImage
                  key={url}
                  attachment={{ ...attachment, url }}
                  url={url}
                  source={source}
                  onOpenLink={onOpenLink}
                  {...(onOpenMediaReview
                    ? {
                        onOpenReview: (item, seconds) =>
                          onOpenMediaReview(row.id, item, seconds),
                      }
                    : {})}
                />
              );
            return (
              <MediaAttachment
                key={url}
                attachment={{ ...attachment, url }}
                media={media}
                mode={mediaMode}
                {...(attachment.kind === "video" && mediaSeekTo !== undefined
                  ? {
                      seekTo: mediaSeekTo,
                      ...(mediaSeekRequest !== undefined
                        ? { seekRequest: mediaSeekRequest }
                        : {}),
                    }
                  : {})}
                {...(onMediaPlayback ? { onPlayback: onMediaPlayback } : {})}
                {...(onOpenMediaReview
                  ? {
                      onOpenReview: (item, seconds) =>
                        onOpenMediaReview(row.id, item, seconds),
                    }
                  : {})}
              />
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
              {canReact && extensions && session && scope && (
                <ReactionTool
                  registry={extensions.tools}
                  session={session}
                  scope={scope}
                  messageId={row.id}
                  disabled={
                    !!row.delivery &&
                    !["accepted", "seen"].includes(row.delivery)
                  }
                />
              )}
            </div>
          )}
          {row.replyCount > 0 && onOpenThread && (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              aria-label={`View thread: ${row.replyCount} ${row.replyCount === 1 ? "reply" : "replies"}${unreadLabel ? `. ${unreadLabel}` : ""}`}
              onClick={(event) => {
                event.currentTarget.focus();
                onOpenThread(row.id, row.threadRootId ?? row.id);
              }}
            >
              {row.participants.length > 0 && (
                <span className={styles.threadAvatars} aria-hidden="true">
                  {row.participants.slice(0, 3).map((id) => {
                    const participant = participantProfiles?.get(id);
                    const name = resolveName(
                      id,
                      participant?.name ?? id.slice(0, 10),
                    );
                    const picture = participant?.picture
                      ? media(participant.picture, "small")
                      : undefined;
                    return (
                      <span
                        key={id}
                        className={styles.threadAvatar}
                        data-avatar-shape={
                          agentPubkeys?.has(id) ? "squircle" : "circle"
                        }
                        title={name}
                      >
                        <Avatar
                          src={picture}
                          alt=""
                          fallback={name}
                          size="fill"
                          shape={agentPubkeys?.has(id) ? "squircle" : "circle"}
                        />
                      </span>
                    );
                  })}
                  {row.participants.length > 3 && (
                    <span className={styles.threadAvatarCount}>
                      +{row.participants.length - 3}
                    </span>
                  )}
                </span>
              )}
              <span>
                {row.replyCount} {row.replyCount === 1 ? "reply" : "replies"}
              </span>
              {unreadLabel && (
                <span
                  className={styles.threadUnread}
                  aria-hidden="true"
                  title={unreadLabel}
                />
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});
// Subscribe only for mounted thread buttons. Evidence and reading remain session-owned;
// rendering a row must not initiate per-thread reads or acknowledge unseen replies.
function useThreadUnread(
  unread: UnreadCapability | undefined,
  channelId: string,
  rootId: string,
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      unread?.subscribe({ kind: "thread", channelId, rootId }, listener) ??
      (() => {}),
    [unread, channelId, rootId],
  );
  const get = useCallback(
    () => unread?.snapshot({ kind: "thread", channelId, rootId }),
    [unread, channelId, rootId],
  );
  return useSyncExternalStore(subscribe, get, get);
}
