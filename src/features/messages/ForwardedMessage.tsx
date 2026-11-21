import referenceStyles from "../../shared/InlineReference.module.css";
import { workflowLabel } from "../relay/workflow-attribution";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { RelaySession } from "../relay/session";
import type { ForwardSnapshot } from "../relay/forwarded-message";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { avatarMedia } from "../../shared/avatar-source";
import { useForwardSource } from "./use-forward-source";
import {
  MessageCard,
  MessageCardBody,
  MessageCardByline,
  messageCardTime,
} from "./MessageCard";

const noop = () => () => {};
const noProfile = () => undefined;
export function ForwardedMessage({
  snapshot,
  session,
  children,
  attachments,
  onOpenLink,
  compact = false,
  fill = false,
}: {
  snapshot: ForwardSnapshot;
  session: RelaySession | undefined;
  children: ReactNode;
  attachments?: ReactNode;
  onOpenLink?(url: string): void;
  compact?: boolean;
  fill?: boolean;
}) {
  const source = useForwardSource(session, snapshot.channelId, snapshot.id);
  const profile = useSyncExternalStore(
    session?.profiles.subscribe ?? noop,
    session
      ? () => session.profiles.snapshot().get(snapshot.authorId)
      : noProfile,
    noProfile,
  );
  useEffect(() => {
    void session?.profiles
      .ensure?.([snapshot.authorId], "background")
      .catch(() => {});
  }, [session, snapshot.authorId]);
  const authorLabel = snapshot.workflow
    ? workflowLabel(snapshot.authorName)
    : snapshot.authorName;
  const date = new Date(snapshot.createdAt * 1000);
  const time = messageCardTime(date);
  const reference = source.reference;
  const known = reference.state === "found" && reference.readable !== false;
  const sourceName = known
    ? reference.channelType === "dm"
      ? "Direct message"
      : reference.channelType === "solo"
        ? "Solo chat"
        : `#${reference.name}`
    : "Private conversation";
  return (
    <MessageCard
      label={
        <>
          <span aria-hidden="true">↪ </span>Forwarded
        </>
      }
      fill={fill}
      aria-label={`Forwarded message from ${authorLabel}, ${time}`}
    >
      <MessageCardByline
        avatar={
          <Avatar
            alt=""
            fallback={authorLabel}
            src={
              snapshot.workflow
                ? null
                : avatarMedia(profile?.picture, session?.media)
            }
            size="small"
            shape={profile?.isAgent ? "squircle" : "circle"}
          />
        }
        author={authorLabel}
        agent={!!profile?.isAgent}
        time={<time dateTime={date.toISOString()}>{time}</time>}
        source={sourceName}
        locked={!known}
      />
      <MessageCardBody compact={compact}>{children}</MessageCardBody>
      {attachments}
      {source.row && onOpenLink && (
        <span className="text-caption">
          <button
            type="button"
            className={referenceStyles.link}
            onClick={() =>
              onOpenLink(
                `buzz://message?${new URLSearchParams({ channel: snapshot.channelId, id: snapshot.id })}`,
              )
            }
          >
            View original
          </button>
        </span>
      )}
      {reference.state === "found" && source.unavailable && (
        <span className="text-body-sm text-subtle">Original unavailable</span>
      )}
    </MessageCard>
  );
}
