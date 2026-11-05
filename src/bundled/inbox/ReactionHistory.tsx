import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { PageTabTarget } from "../../features/conversation/contracts";
import { useChannelList } from "../../features/relay/react";
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

export type ReactionGroup = ReactionEntry & { reactions: ReactionEntry[] };

/** Group loaded history by its original post, newest activity first. */
export function groupReactions(rows: ReactionEntry[]): ReactionGroup[] {
  const groups = new Map<string, ReactionGroup>();
  for (const row of [...rows].sort(
    (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  )) {
    const key = JSON.stringify([row.channelId, row.messageId]);
    const group = groups.get(key);
    if (group) group.reactions.push(row);
    else groups.set(key, { ...row, reactions: [row] });
  }
  return [...groups.values()];
}

/** One history reader shared by All and the focused Reactions view. */
export function useReactionHistory(session: RelaySession, enabled = true) {
  const list = useChannelList(session.channels);
  const ready = enabled && list.status === "ready";
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
  const [rows, setRows] = useState<ReactionEntry[]>([]);
  const [loadedKey, setLoadedKey] = useState<string>();
  const [cursor, setCursor] = useState<ReactionCursor>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);
  const load = async (older = false) => {
    if (!enabled || controller.current) return;
    if (!ready) {
      session.channels.ensureList();
      return;
    }
    setLoadedKey(key);
    const owned = new AbortController();
    controller.current = owned;
    setLoading(true);
    setError(undefined);
    if (!older) {
      setRows([]);
      setCursor(undefined);
    }
    try {
      const read = () =>
        session.reactionHistory(older ? cursor : undefined, {
          signal: owned.signal,
        });
      const page = await read().catch((failure: unknown) => {
        // Access discovery can retire a read without changing the admitted IDs
        // or timestamp. Retry once against the session's fresh access guards.
        if (
          !owned.signal.aborted &&
          failure instanceof DOMException &&
          failure.name === "AbortError"
        )
          return read();
        throw failure;
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
    // Restart the owned read after roster discovery or the admitted set changes.
    void key;
    void list.asOf;
    if (ready) initialize();
    return () => {
      controller.current?.abort();
      controller.current = undefined;
    };
  }, [key, ready, list.asOf]);
  const profileIds = [...new Set(rows.map((row) => row.authorId))]
    .sort()
    .join(":");
  useEffect(() => {
    if (profileIds)
      void session.profiles
        .ensure(profileIds.split(":"), "background")
        .catch(() => {});
  }, [session, profileIds]);
  return {
    rows: enabled && loadedKey === key ? rows : [],
    cursor: enabled && loadedKey === key ? cursor : undefined,
    loading:
      enabled && list.status !== "error" && (loadedKey !== key || loading),
    error: enabled
      ? (list.error ?? (loadedKey === key ? error : undefined))
      : undefined,
    load,
    setError,
    channels,
  };
}

export function ReactionRow({
  row,
  session,
  channel,
  open,
  onError,
}: {
  row: ReactionGroup;
  session: RelaySession;
  channel: ReturnType<typeof useChannelList>["channels"][number] | undefined;
  open(target: PageTabTarget): boolean;
  onError(error: string): void;
}) {
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const name = useIdentityNames(session.names);
  const profile = profiles.get(row.authorId);
  const sender = name(
    row.authorId,
    profile?.name ?? formatPublicKey(row.authorId) ?? "Unknown sender",
  );
  const authors = [
    ...new Set(row.reactions.map((reaction) => reaction.authorId)),
  ];
  const senderLabel =
    authors.length > 1 ? `${sender} +${authors.length - 1}` : sender;
  const emojiCounts = new Map<
    string,
    { reaction: ReactionEntry; authors: Set<string> }
  >();
  for (const reaction of row.reactions) {
    const content = reaction.content === "+" ? "👍" : reaction.content;
    const key = JSON.stringify([content, reaction.emoji]);
    const count = emojiCounts.get(key);
    if (count) count.authors.add(reaction.authorId);
    else
      emojiCounts.set(key, {
        reaction: { ...reaction, content },
        authors: new Set([reaction.authorId]),
      });
  }
  return (
    <NavigationItem
      aria-label={`Open message reacted to by ${senderLabel}`}
      onClick={() => {
        if (
          !open({
            channelId: row.channelId,
            threadId: row.rootId ?? row.messageId,
            messageId: row.messageId,
          })
        )
          onError("Could not open the conversation. Try again.");
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
                {senderLabel}
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
            {[...emojiCounts].map(([key, { reaction, authors }]) => (
              <span key={key}>
                <ReactionGlyph
                  reaction={{
                    content: reaction.content,
                    ...(reaction.emoji ? { emoji: reaction.emoji } : {}),
                    events: [],
                  }}
                  session={session}
                />{" "}
                {authors.size}{" "}
              </span>
            ))}
          </span>
          <span className={`text-body text-subtle ${styles.preview}`}>
            {messagePreview(row.preview) || "Your message"}
          </span>
        </span>
      }
    />
  );
}

export function ReactionHistoryControls({
  history,
  showError = true,
}: {
  history: ReturnType<typeof useReactionHistory>;
  showError?: boolean;
}) {
  const { loading, error, cursor, load } = history;
  return (
    <>
      <div className={styles.notice}>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => void load()}
        >
          Refresh reactions
        </Button>
        {cursor && (
          <Button size="sm" disabled={loading} onClick={() => void load(true)}>
            Load older reactions
          </Button>
        )}
      </div>
      {showError && error && (
        <div className={styles.notice} role="alert">
          {error}
          <Button size="sm" onClick={() => void load(!!cursor)}>
            Retry reactions
          </Button>
        </div>
      )}
      {loading && (
        <div className={styles.notice} role="status">
          Loading reactions…
        </div>
      )}
    </>
  );
}

export function ReactionHistory({
  session,
  open,
}: {
  session: RelaySession;
  open(target: PageTabTarget): boolean;
}) {
  const history = useReactionHistory(session);
  const { rows, cursor, loading, error, channels, setError } = history;
  return (
    <>
      <ReactionHistoryControls history={history} />
      <section
        className={styles.scroll}
        aria-label="Reaction history"
        aria-busy={loading}
      >
        {groupReactions(rows).map((row) => (
          <ReactionRow
            key={row.id}
            row={row}
            session={session}
            channel={channels.find((channel) => channel.id === row.channelId)}
            open={open}
            onError={setError}
          />
        ))}
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
      </section>
    </>
  );
}
