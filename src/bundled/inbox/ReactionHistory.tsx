import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { PageTabTarget } from "../../features/conversation/contracts";
import { useChannelList } from "../../features/relay/react";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useIdentityNames } from "../../features/identity-names/react";
import { messagePreview } from "../../features/notifications/content";
import { channelText } from "../../features/channels/channel-icon";
import { formatPublicKey } from "../../shared/identity/public-key";
import { avatarMedia } from "../../shared/avatar-source";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { BellIcon } from "../../shared/design-system/icons";
import { ReactionGlyph } from "../../features/messages/MessageReactions";
import { Button } from "../../shared/design-system/ui/Button";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import type {
  ReactionCursor,
  ReactionEntry,
} from "../../features/relay/reaction-history";
import styles from "./Inbox.module.css";

export function ReactionHistory({
  session,
  open,
}: {
  session: RelaySession;
  open(target: PageTabTarget): boolean;
}) {
  const list = useChannelList(session.channels);
  const channels = list.channels.filter(
    (channel) =>
      !channel.cached &&
      !channel.metadataPending &&
      !channel.huddle &&
      !channel.archived &&
      channel.members?.includes(session.viewer ?? ""),
  );
  const key = channels
    .map((channel) => channel.id)
    .sort()
    .join(":");
  // Changing access remounts the owned read, cancelling work and retiring its rows.
  return (
    <ReactionHistoryList
      key={key}
      session={session}
      channels={channels}
      open={open}
    />
  );
}

function ReactionHistoryList({
  session,
  channels,
  open,
}: {
  session: RelaySession;
  channels: ReturnType<typeof useChannelList>["channels"];
  open(target: PageTabTarget): boolean;
}) {
  const [rows, setRows] = useState<ReactionEntry[]>([]);
  const [cursor, setCursor] = useState<ReactionCursor>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);
  const load = async (older = false) => {
    if (controller.current) return;
    const owned = new AbortController();
    controller.current = owned;
    setLoading(true);
    setError(undefined);
    if (!older) {
      setRows([]);
      setCursor(undefined);
    }
    try {
      const page = await session.reactionHistory(older ? cursor : undefined, {
        signal: owned.signal,
      });
      if (owned.signal.aborted) return;
      setRows((previous) => {
        const combined = [...(older ? previous : []), ...page.rows].sort(
          (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
        );
        const unique = new Map<string, ReactionEntry>();
        for (const row of combined) {
          const key = JSON.stringify([
            row.channelId,
            row.messageId,
            row.authorId,
            row.content,
            row.emoji,
          ]);
          if (!unique.has(key)) unique.set(key, row);
        }
        return [...unique.values()];
      });
      setCursor(page.cursor);
    } catch (failure) {
      if (!owned.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not load reactions.",
        );
    } finally {
      if (!owned.signal.aborted) {
        controller.current = undefined;
        setLoading(false);
      }
    }
  };
  const initialize = useEffectEvent(() => {
    void load();
  });
  useEffect(() => {
    initialize();
    return () => {
      controller.current?.abort();
      controller.current = undefined;
    };
    // The parent keys this owner by the admitted channel set.
  }, []);
  const profileIds = [...new Set(rows.map((row) => row.authorId))]
    .sort()
    .join(":");
  const selection = useMemo(
    () =>
      selectProfiles(session.profiles, profileIds ? profileIds.split(":") : []),
    [session, profileIds],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const name = useIdentityNames(session.names);
  useEffect(() => {
    if (profileIds)
      void session.profiles
        .ensure(profileIds.split(":"), "background")
        .catch(() => {});
  }, [session, profileIds]);
  return (
    <>
      <div className={styles.notice}>
        <span className="text-body-sm text-subtle">
          Reactions to your messages, newest first.
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => void load()}
        >
          Refresh reactions
        </Button>
      </div>
      <section
        className={styles.scroll}
        aria-label="Reaction history"
        aria-busy={loading}
      >
        {error && (
          <div className={styles.notice} role="alert">
            {error}
            <Button size="sm" onClick={() => void load(!!cursor)}>
              Retry reactions
            </Button>
          </div>
        )}
        {rows.map((row) => {
          const profile = profiles.get(row.authorId);
          const sender = name(
            row.authorId,
            profile?.name ?? formatPublicKey(row.authorId) ?? "Unknown sender",
          );
          const channel = channels.find(
            (channel) => channel.id === row.channelId,
          );
          return (
            <NavigationItem
              key={row.id}
              aria-label={`Open message reacted to by ${sender}`}
              onClick={() => {
                if (
                  !open({
                    channelId: row.channelId,
                    threadId: row.rootId ?? row.messageId,
                    messageId: row.messageId,
                  })
                )
                  setError("Could not open the conversation. Try again.");
              }}
              icon={
                <Avatar
                  size="default"
                  alt=""
                  fallback={sender}
                  src={avatarMedia(profile?.picture, session.media)}
                  shape={profile?.isAgent ? "squircle" : "circle"}
                />
              }
              label={
                <span className={styles.content}>
                  <span className={styles.heading}>
                    <span className={styles.identity}>
                      <strong className="text-label-sm text-standard">
                        {sender}
                      </strong>
                      <span className="text-caption text-subtle">
                        {channel ? channelText(channel) : "Conversation"}
                      </span>
                    </span>
                    <time
                      className="text-caption text-subtle"
                      dateTime={new Date(row.createdAt * 1000).toISOString()}
                    >
                      {relativeTimestamp(row.createdAt)}
                    </time>
                  </span>
                  <span className="text-body">
                    Reacted{" "}
                    <ReactionGlyph
                      reaction={{
                        content: row.content === "+" ? "👍" : row.content,
                        ...(row.emoji ? { emoji: row.emoji } : {}),
                        events: [],
                      }}
                      session={session}
                    />
                  </span>
                  <span className={`text-body text-subtle ${styles.preview}`}>
                    {messagePreview(row.preview) || "Your message"}
                  </span>
                </span>
              }
            />
          );
        })}
        {!rows.length && !loading && !error && (
          <EmptyState
            icon={<BellIcon />}
            title={
              cursor
                ? "No reactions to your messages in this batch"
                : "No reactions yet"
            }
            description={
              cursor
                ? "Load older reactions to keep looking."
                : "Other people's reactions to your messages appear here."
            }
          />
        )}
        {loading && (
          <div className={styles.notice} role="status">
            Loading reactions…
          </div>
        )}
        {cursor && !error && (
          <div className={styles.notice}>
            <Button
              size="sm"
              disabled={loading}
              onClick={() => void load(true)}
            >
              Load older reactions
            </Button>
          </div>
        )}
      </section>
    </>
  );
}
