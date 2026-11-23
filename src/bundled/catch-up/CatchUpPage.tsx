import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { messagePreview } from "../../features/notifications/content";
import { CheckIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { useChannelLabels } from "../channels/useChannelLabels";
import styles from "./CatchUpPage.module.css";
import { useCatchUpSwipe } from "./useCatchUpSwipe";

export function CatchUpPage({
  relay,
  navigator,
}: {
  relay: RelayData;
  navigator: Navigation;
}) {
  const connection = useRelayConnection(relay);
  const { viewer, origin, session } = connection;
  return (
    <FullPageSurface aria-label="Catch up">
      <div className={styles.page}>
        <PanelHeader
          title={
            <PanelHeaderLabel
              title="Catch up"
              icon={<CheckIcon size="1rem" />}
            />
          }
        />
        {connection.status === "ready" && viewer && origin ? (
          <CatchUpView
            key={`${connection.scope}:${connection.generation}`}
            session={session}
            scope={{ viewer, communityOrigin: origin }}
            navigator={navigator}
          />
        ) : (
          <p className={styles.body} role="status">
            Connect to a community to catch up.
          </p>
        )}
      </div>
    </FullPageSurface>
  );
}

/** Preview-only: never creates a reading lease or marks a channel seen. */
export function CatchUpView({
  session,
  scope,
  navigator,
}: {
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
}) {
  const list = useChannelList(session.channels);
  const { channels } = useChannelLabels(
    list.channels,
    session.profiles,
    session.names,
  );
  const unread = session.unread;
  const sync = useSyncExternalStore(
    unread.subscribeSync,
    unread.sync,
    unread.sync,
  );
  const inbox = useSyncExternalStore(
    unread.subscribeInbox,
    unread.inbox,
    unread.inbox,
  );
  const feed = useSyncExternalStore(
    session.inboxFeed.subscribe,
    session.inboxFeed.snapshot,
    session.inboxFeed.snapshot,
  );
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = list.channels.map((channel) =>
        unread.subscribe({ kind: "channel", channelId: channel.id }, listener),
      );
      return () => {
        for (const stop of stops) stop();
      };
    },
    [unread, list.channels],
  );
  // A primitive snapshot keeps aggregate subscriptions stable between changes.
  const snapshot = useCallback(
    () =>
      JSON.stringify(
        list.channels.map((channel) =>
          unread.snapshot({ kind: "channel", channelId: channel.id }),
        ),
      ),
    [unread, list.channels],
  );
  useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    let current = true;
    setChecking(true);
    void unread
      .ensure()
      .catch((cause) => {
        if (current) setError(String(cause));
      })
      .finally(() => {
        if (current) setChecking(false);
      });
    return () => {
      current = false;
    };
  }, [unread]);
  const candidates = channels
    .filter((channel) => {
      if (
        channel.archived ||
        channel.cached ||
        channel.huddle ||
        !channel.members?.includes(scope.viewer)
      )
        return false;
      const state = unread.snapshot({ kind: "channel", channelId: channel.id });
      return state.manual !== "none" || (state.observedCount ?? 0) > 0;
    })
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) ||
        a.id.localeCompare(b.id),
    );
  const channel = candidates.find((candidate) => !skipped.has(candidate.id));
  const loading =
    checking || list.status === "idle" || list.status === "loading";
  const failure =
    error ??
    list.error ??
    sync.error ??
    list.channels
      .map(
        (channel) =>
          unread.snapshot({ kind: "channel", channelId: channel.id }).error,
      )
      .find(Boolean);
  const status = channel
    ? unread.snapshot({ kind: "channel", channelId: channel.id })
    : undefined;
  const evidence = inbox.items.find((item) => item.channelId === channel?.id);
  const incomplete =
    evidence &&
    [evidence.previewMessageId, ...evidence.messageIds].some(
      (id) => id && feed.incomplete.includes(id),
    );
  const preview =
    channel?.preview ||
    (incomplete
      ? "Preview updates are not ready. Open the conversation for context."
      : evidence
        ? messagePreview(evidence.preview)
        : "No message preview available. Open the conversation for context.");
  async function markRead() {
    if (!channel || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await unread.markChannelRead(channel.id);
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  function keepUnread() {
    if (!channel || busy.current || loading) return;
    setError(undefined);
    setSkipped((previous) => new Set([...previous, channel.id]));
  }
  const swipe = useCatchUpSwipe({
    channelId: channel?.id,
    disabled: pending || loading,
    read: () => {
      void markRead();
    },
    keep: keepUnread,
  });
  async function refresh() {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    setError(undefined);
    try {
      await Promise.all([session.channels.refreshList?.(), unread.refresh()]);
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      if (alive.current) setChecking(false);
    }
  }
  const restart = useRef<HTMLButtonElement>(null);
  const hadCard = useRef(false);
  useEffect(() => {
    if (hadCard.current && !channel && !loading) restart.current?.focus();
    hadCard.current = !!channel;
  }, [channel, loading]);
  return (
    <div className={styles.body}>
      <p className="text-body text-subtle">
        Swipe right to mark as read; swipe left to keep unread. Use your
        trackpad, swipe on touch, or drag the card header. Previews leave
        messages unread.
      </p>
      {failure && (
        <div role="alert">
          <p className="text-body">{failure}</p>
          <Button
            size="sm"
            disabled={pending || loading}
            onClick={() => void refresh()}
          >
            Retry
          </Button>
        </div>
      )}
      <LoadingRegion pending={loading} label="Checking unread conversations…">
        {null}
      </LoadingRegion>
      {channel ? (
        <article
          ref={swipe.ref}
          className={styles.preview}
          style={{ transform: `translateX(${swipe.offset}px)` }}
          aria-label={`Unread conversation: ${channel.name}`}
          aria-busy={pending}
        >
          <p className="text-caption text-subtle" aria-live="polite">
            {swipe.offset
              ? swipe.offset > 0
                ? "→ Mark as read"
                : "← Keep unread"
              : "← Keep unread · Mark as read →"}
          </p>
          <p className="text-caption text-subtle">
            {
              candidates.filter((candidate) => !skipped.has(candidate.id))
                .length
            }{" "}
            conversations left to review
          </p>
          <h3 className="text-label">{channel.name}</h3>
          <p className="text-body text-subtle">
            {status?.manual !== "none"
              ? "Marked unread"
              : `${status?.observedCount ?? 0} observed unread messages`}
            {status?.freshness === "stale" ? " · May be out of date" : ""}
          </p>
          <p data-catch-up-message className={`${styles.message} text-body`}>
            {preview}
          </p>
          <div className={styles.actions}>
            <Button
              variant="prominent"
              loading={pending}
              disabled={loading}
              onClick={() => void markRead()}
            >
              Mark as read
            </Button>
            <Button disabled={pending || loading} onClick={keepUnread}>
              Keep unread
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                void navigator
                  .open({
                    version: 1,
                    kind: "conversation",
                    scope,
                    channelId: channel.id,
                  })
                  .then((result) => {
                    if (alive.current && result.status === "failed")
                      setError("Could not open the conversation. Try again.");
                  })
                  .catch((cause) => {
                    if (alive.current) setError(String(cause));
                  });
              }}
            >
              Open conversation
            </Button>
          </div>
        </article>
      ) : (
        !loading &&
        !failure && (
          <EmptyState
            icon={<CheckIcon />}
            title={
              candidates.length
                ? "Review complete"
                : "No unread conversations observed"
            }
            description={
              candidates.length
                ? "Conversations you kept unread are still unread."
                : "Unread evidence covers recent activity and may be incomplete. Refresh to check again."
            }
            action={
              <Button
                ref={restart}
                onClick={() => {
                  setSkipped(new Set());
                  void refresh();
                }}
              >
                Check again
              </Button>
            }
          />
        )
      )}
    </div>
  );
}
