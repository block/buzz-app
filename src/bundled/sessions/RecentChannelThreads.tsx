import type { createRetainedSessions } from "./retained-sessions";
import { SessionActivity } from "./SessionActivity";
import { useMemo } from "react";
import type { ChannelThreadDirectoryProps } from "../../features/conversation/contracts";
import { useChannelWindow } from "../../features/relay/react";
import { Button } from "../../shared/design-system/ui/Button";
import { SessionsDirectory, type ThreadPreviewRow } from "./SessionsDirectory";
import { SessionUnread } from "./SessionUnread";
import styles from "./SessionsDirectory.module.css";

import {
  ROOT_LIMIT,
  sessionRoots,
  useSessionEvidence,
} from "./session-evidence";

/** Mounting the selected tab reuses the existing channel owner; never a reader per row. */
export function RecentChannelThreads({
  session,
  channelId,
  openThread,
  owner,
}: ChannelThreadDirectoryProps & {
  owner?: ReturnType<typeof createRetainedSessions>;
}) {
  const window = useChannelWindow(session.channels, channelId);
  const candidates = useMemo(
    () => sessionRoots(window.rows, channelId),
    [window.rows, channelId],
  );
  const roots = candidates.slice(0, ROOT_LIMIT);
  const evidence = useSessionEvidence(session, channelId, roots);
  const rows: ThreadPreviewRow[] = roots
    .filter((row) => evidence.eligible.has(row.id))
    .map((row) => ({
      rootId: row.id,
      title: row.content.trim().replace(/\s+/g, " ").slice(0, 160) || "Thread",
      replyCount: row.replyCount,
      lastMessageAt: Math.max(
        row.createdAt,
        evidence.latestMessages.get(row.id) ?? row.createdAt,
      ),
    }));
  const loading = window.status === "idle" || window.status === "loading";
  return (
    <SessionsDirectory
      rows={rows}
      now={Date.now() / 1000}
      openThread={openThread}
      renderStatus={(rootId) => (
        <>
          {owner && (
            <SessionActivity
              evidence={owner.forSession(session)}
              channelId={channelId}
              rootId={rootId}
            />
          )}
          <SessionUnread
            unread={session.unread}
            channelId={channelId}
            rootId={rootId}
          />
        </>
      )}
      showEmpty={
        !loading && !window.error && !evidence.loading && !evidence.partial
      }
      controls={
        <>
          {loading && <p role="status">Loading channel history…</p>}
          {evidence.loading && (
            <p role="status">Checking threads for agents…</p>
          )}
          {!evidence.loading && evidence.partial && (
            <div role="status">
              <p>Some threads could not be checked.</p>
              <Button onClick={evidence.retry}>Retry session check</Button>
            </div>
          )}
          {candidates.length > ROOT_LIMIT && (
            <p role="status">
              Checking the newest {ROOT_LIMIT} loaded roots only.
            </p>
          )}
          {window.freshness === "cached" && (
            <p role="status">Showing cached channel history.</p>
          )}
          {window.error && (
            <div role="alert">
              <p>{window.error}</p>
              <Button
                onClick={() =>
                  session.channels.refresh
                    ? session.channels.refresh(channelId)
                    : session.channels.ensure(channelId)
                }
              >
                Retry channel history
              </Button>
            </div>
          )}
          <div className={styles.actions}>
            {session.channels.refresh && (
              <Button
                disabled={loading || window.loadingOlder}
                onClick={() => session.channels.refresh?.(channelId)}
              >
                Refresh loaded history
              </Button>
            )}
            {window.hasMore && !window.historyLimited && (
              <Button
                disabled={loading || window.loadingOlder}
                onClick={() => session.channels.loadOlder(channelId)}
              >
                {window.loadingOlder
                  ? "Loading older history…"
                  : "Load older history"}
              </Button>
            )}
          </div>
          {window.historyLimited && (
            <p role="status">Loaded history reached its retention limit.</p>
          )}
        </>
      }
    />
  );
}
