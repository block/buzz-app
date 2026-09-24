import { useIdentityNames } from "../identity-names/react";
import { Button } from "../../shared/design-system/ui/Button";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { usePresenceStatus } from "../presence/react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  memo,
  useRef,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../relay/session";
import type { UnreadCapability } from "../relay/unread";
import { MediaAttachment, type MediaPlayback } from "./MediaAttachment";
import { parseMediaTimeReply } from "./media-timecode";
import { profileTarget } from "../profiles/target";
import { MessageBody } from "../conversation/MessageBody";
import { InlineText } from "../conversation/InlineText";
import type { ConversationExtensions } from "../conversation/contracts";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { AttachmentImage } from "./AttachmentImage";
import { DeliveryNotice } from "./DeliveryNotice";
import { AudioAttachment } from "./AudioAttachment";
import { isProxySource } from "./attachment-source";
import { FileAttachment } from "./FileAttachment";
import { useReferenceDirectory } from "./ReferenceText";
import { MessageMarkdown } from "./MessageMarkdown";
import { safeMessageUrl } from "../relay/message-content";
import styles from "./Messages.module.css";
import { usesLargeEmojiPresentation } from "./emoji-size";
import { MessageReactionControls, MessageReactions } from "./MessageReactions";

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
  const agentPresence = usePresenceStatus(
    session?.presence,
    avatarShape === "squircle" ? row.authorId : undefined,
  );
  const timeReply = row.diff ? undefined : parseMediaTimeReply(row.content);
  const replaceTime = !!timeReply && !!onMediaTime;
  const displayRow = replaceTime ? { ...row, content: timeReply.content } : row;
  const emojiOnly = usesLargeEmojiPresentation(displayRow.content, row.emoji);
  const canReact = !!(
    extensions &&
    session &&
    scope &&
    session.outbox?.supports(7) &&
    session.outbox.supports(5) &&
    (!session.channels.get ||
      channelList.channels.some((channel) => channel.id === row.channelId)) &&
    !channelList.channels.find((channel) => channel.id === row.channelId)
      ?.archived &&
    !channelList.channels.find((channel) => channel.id === row.channelId)
      ?.readOnly
  );
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const body = row.diff ? (
    <div>
      <p className="text-label-sm">{row.diff.filePath || "Diff"}</p>
      {row.diff.description && (
        <p className="text-body-sm">{row.diff.description}</p>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: The raw scroll region preserves preformatted text and needs keyboard access. */}
      <pre
        className={styles.rawDiff}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The raw scroll owner must support keyboard scrolling.
        tabIndex={0}
        role="region"
        aria-label="Raw diff"
      >
        {row.content || "No diff content"}
      </pre>
      {row.diff.truncated && (
        <p className="text-body-sm">
          Diff truncated. View the full diff at the source repository.
        </p>
      )}
    </div>
  ) : (
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
            size="default"
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
                statusBadge={
                  agentPresence === "unknown" ? undefined : agentPresence
                }
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
            statusBadge={
              agentPresence === "unknown" ? undefined : agentPresence
            }
          />
        )}
        <div className={styles.messageBody}>
          {!row.membership && (
            <MessageActionBar
              menuTriggerRef={menuTrigger}
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
              quickControls={
                quickControls ??
                (canReact && session && scope && extensions ? (
                  <MessageReactionControls
                    row={row}
                    session={session}
                    scope={scope}
                    tools={extensions.tools}
                    inline={extensions.inline}
                    disabled={
                      !!row.delivery &&
                      !["accepted", "seen"].includes(row.delivery)
                    }
                  />
                ) : undefined)
              }
              overflowItems={overflowItems}
            />
          )}
          <div className={styles.byline}>
            <strong>{name}</strong>
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
          {extensions?.messages ? (
            <MessageBody registry={extensions.messages} message={row}>
              {body}
            </MessageBody>
          ) : (
            body
          )}
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
          {session && scope && extensions ? (
            <div className={styles.reactions}>
              <MessageReactions
                onFocusedRemoval={() => menuTrigger.current?.focus()}
                row={row}
                session={session}
                scope={scope}
                tools={extensions.tools}
                inline={extensions.inline}
                disabled={
                  !canReact ||
                  (!!row.delivery &&
                    !["accepted", "seen"].includes(row.delivery))
                }
              />
            </div>
          ) : (
            row.reactions.length > 0 && (
              <div className={styles.reactions}>
                {row.reactions.map((reaction) => (
                  <span
                    key={JSON.stringify([
                      reaction.content,
                      reaction.emoji?.url,
                    ])}
                  >
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
                    )}{" "}
                    {
                      new Set(reaction.events.map((event) => event.authorId))
                        .size
                    }
                  </span>
                ))}
              </div>
            )
          )}
          {row.replyCount > 0 && onOpenThread && (
            <Button
              variant="ghost"
              size="sm"
              style={{ paddingInlineStart: "var(--space-1)" }}
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
