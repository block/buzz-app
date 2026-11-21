import { Button } from "../../shared/design-system/ui/Button";
import { CountBadge } from "../../shared/design-system/ui/CountBadge";
import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import { rowUnread } from "../../features/relay/unread";
import {
  useConfirmedMute,
  useNeedsYou,
} from "../../features/relay/useNeedsYou";
import styles from "./Channels.module.css";

type UnreadSnapshot = ReturnType<RelaySession["unread"]["snapshot"]>;

/** What the channel's row shows: opening it quiets the row (`row`) while
 * its messages and threads stay unread elsewhere. */
const shown = (snapshot: UnreadSnapshot) => snapshot.row ?? snapshot;

/** Bold tracks ordinary backlog, the quiet "something's new" signal. It never
 * feeds a count, an order or a cue; those read `needsYou`. */
export function ordinaryUnread(
  snapshot: UnreadSnapshot,
  dm: boolean,
  muted = false,
) {
  const { observedCount, attentionCount } = shown(snapshot);
  const count = observedCount ?? 0;
  return (
    snapshot.manual !== "none" ||
    (!muted && (dm ? count > 0 : count > (attentionCount ?? 0)))
  );
}

/** The channel's observed backlog, for bold and its spoken description. */
export function useUnreadState(
  session: RelaySession,
  channelId: string,
  dm: boolean,
) {
  const target = useMemo(
    () => ({ kind: "channel" as const, channelId }),
    [channelId],
  );
  const subscribe = useCallback(
    (listener: () => void) => session.unread.subscribe(target, listener),
    [session, target],
  );
  const get = useCallback(
    () => session.unread.snapshot(target),
    [session, target],
  );
  const snapshot = useSyncExternalStore(subscribe, get, get);
  const muted = useConfirmedMute(session, channelId);
  const { observedCount: count } = shown(snapshot);
  const manual = snapshot.manual !== "none";
  const unread = rowUnread(snapshot, dm, muted);
  const ordinary = ordinaryUnread(snapshot, dm, muted);
  return { snapshot, count, manual, unread, ordinary, muted };
}

const needsYouLabel = (count: number) => `${count} unread`;

export function UnreadBadge({
  session,
  channelId,
  dm = false,
  label,
  labelUnread = "ordinary",
  preserveUnread = false,
  unreadDot = false,
}: {
  session: RelaySession;
  channelId: string;
  dm?: boolean;
  label?: ReactNode;
  /** Solo labels emphasize every unread message, so needing you adds no dot. */
  labelUnread?: "ordinary" | "all";
  /** Preserve observed evidence for Solo destinations with their own labels.
   * Their bold says it all, so needing you adds no dot there either. */
  preserveUnread?: boolean;
  /** Draw the dot for any unread: a Solo tile has no text to bold. */
  unreadDot?: boolean;
}) {
  const {
    snapshot,
    count,
    manual,
    unread: quietUnread,
    ordinary,
    muted,
  } = useUnreadState(session, channelId, dm);
  const needs = useNeedsYou(session, channelId);
  const unread =
    labelUnread === "all" || preserveUnread
      ? manual || (count ?? 0) > 0
      : quietUnread;
  if (!unread && !needs.waiting && label === undefined) return null;
  const unreadLabel = manual
    ? `Marked unread${snapshot.manual === "local-only" ? " on this device only" : ""}`
    : `${count} observed unread messages${snapshot.freshness === "stale" ? "; may be out of date" : ""}. Not an exact total.`;
  // One spoken status per row. Needing you already says the row is unread, so
  // it replaces the observed count; a manual mark still adds its note.
  const status = needs.waiting
    ? manual
      ? `${needsYouLabel(needs.count)}. ${unreadLabel}`
      : needsYouLabel(needs.count)
    : unreadLabel;
  const dot = labelUnread === "ordinary" && !preserveUnread;
  return (
    <>
      {label !== undefined && (
        <span
          data-channel-unread-title={
            (labelUnread === "all" ? unread : ordinary) || undefined
          }
        >
          {label}
        </span>
      )}
      {(unread || needs.waiting) && (
        <span
          className={styles.unreadState}
          data-channel-unread={unread || undefined}
          data-channel-muted={muted || undefined}
          role="img"
          aria-label={status}
        />
      )}
      {unreadDot && unread && (
        <span
          className={styles.needsYouDot}
          data-tile-unread-dot=""
          aria-hidden="true"
        />
      )}
      {needs.waiting && (
        <span
          className={dot ? styles.needsYouDot : undefined}
          data-channel-needs-you=""
          aria-hidden="true"
        />
      )}
    </>
  );
}

/** Needing you on an identity tile: a corner count (see `needsYou`). A tile
 * that only has ordinary backlog shows nothing; it has no label to bold. */
export function UnreadCount({
  session,
  channelId,
  dm = false,
}: {
  session: RelaySession;
  channelId: string;
  dm?: boolean;
}) {
  const needs = useNeedsYou(session, channelId);
  if (!needs.waiting)
    return <UnreadBadge session={session} channelId={channelId} dm={dm} />;
  return (
    <span data-channel-needs-you="">
      <CountBadge
        count={needs.count}
        label={needsYouLabel(needs.count)}
        placement="corner"
      />
    </span>
  );
}

export function UnreadOptions({
  session,
  channelId,
}: {
  session: RelaySession;
  channelId?: string | undefined;
}) {
  const sync = useSyncExternalStore(
    session.unread.subscribeSync,
    session.unread.sync,
    session.unread.sync,
  );
  const [error, setError] = useState<string>();
  const run = (operation: Promise<unknown>) => {
    setError(undefined);
    void operation.catch((cause) =>
      setError(
        cause instanceof Error ? cause.message : "Read-state operation failed",
      ),
    );
  };
  return (
    <>
      {channelId && (
        <Button
          type="button"
          onClick={() =>
            run(session.unread.markUnreadLocal({ kind: "channel", channelId }))
          }
        >
          Mark as unread
        </Button>
      )}
      {channelId && sync.capability === "frontier-sync" && (
        <Button
          type="button"
          onClick={() => {
            const last = session.channels
              .window(channelId)
              .rows.filter((row) => !row.membership && !row.huddle)
              .at(-1);
            if (last)
              run(
                session.unread.markThrough(
                  { kind: "channel", channelId },
                  last.id,
                ),
              );
            else setError("Load a verified message before marking through it.");
          }}
        >
          Mark as read through loaded messages
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Unread status</summary>
        <p>
          Observed messages only—not exact totals. Marking a whole channel
          unread syncs to your other devices when this relay supports it;
          otherwise it stays on this device. Older read hints can expire; this
          is not an everlasting read receipt log.
        </p>
        <p>
          Read sync: {sync.capability} · {sync.status}
        </p>
        {sync.error && <p role="alert">{sync.error}</p>}
        <Button type="button" onClick={() => run(session.unread.refresh())}>
          Refresh unread observations
        </Button>
        {sync.capability === "frontier-sync" && (
          <Button type="button" onClick={() => run(session.unread.retrySync())}>
            Retry read sync
          </Button>
        )}
      </details>
    </>
  );
}
