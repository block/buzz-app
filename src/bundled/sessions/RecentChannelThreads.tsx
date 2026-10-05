import { useChannelIdentityNames } from "../../features/identity-names/react";
import { profileMentionParts } from "../../features/messages/profile-mentions";
import { profileKey } from "../../features/profiles/target";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { InlineChip } from "../../shared/design-system/ui/InlineChip";
import { formatPublicKey } from "../../shared/identity/public-key";
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
  const resolveName = useChannelIdentityNames(session, channelId);
  const agents = session.agentChoices.snapshot().identities;
  const rows: ThreadPreviewRow[] = roots
    .filter((row) => evidence.eligible.has(row.id))
    .map((row) => {
      const profile = evidence.profiles.get(row.authorId);
      const author = resolveName(
        row.authorId,
        profile?.name || formatPublicKey(row.authorId) || "Unknown author",
      );
      let offset = 0;
      return {
        rootId: row.id,
        title:
          row.content.trim().replace(/\s+/g, " ").slice(0, 160) || "Thread",
        // Bind against the full, unmodified body before collapsing whitespace.
        preview: row.content.trim()
          ? profileMentionParts(row, evidence.profiles, agents).map((part) => {
              const start = offset;
              const collapsed = part.text.replace(/\s+/g, " ");
              const text = start === 0 ? collapsed.trimStart() : collapsed;
              offset += text.length;
              if (start >= 160) return null;
              const key = part.target && profileKey(part.target);
              return key && offset <= 160 && evidence.known.has(key) ? (
                <InlineChip
                  key={start}
                  address={{ kind: "agent", id: key }}
                  face={{
                    label: resolveName(key, part.text.slice(1)),
                    loading: false,
                    resolved: true,
                  }}
                  interactive={false}
                />
              ) : (
                text.slice(0, 160 - start)
              );
            })
          : "Thread",
        avatar: (
          <Avatar
            size="small"
            alt={`Started by ${author}`}
            fallback={author}
            src={
              profile?.picture
                ? session.media(profile.picture, "small")
                : undefined
            }
            shape={evidence.known.has(row.authorId) ? "squircle" : "circle"}
          />
        ),
        replyCount: row.replyCount,
        lastMessageAt: Math.max(
          row.createdAt,
          evidence.latestMessages.get(row.id) ?? row.createdAt,
        ),
      };
    });
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
              <Button variant="link" size="sm" onClick={evidence.retry}>
                Retry session check
              </Button>
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
                variant="link"
                size="sm"
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
          {window.loadingOlder && <p role="status">Loading older history…</p>}
          <details className={styles.historyOptions}>
            <summary>History options</summary>
            <div className={styles.actions}>
              <span>
                Checked history · replies sampled; some sessions may be missing.
              </span>
              {session.channels.refresh && (
                <Button
                  variant="link"
                  size="sm"
                  disabled={loading || window.loadingOlder}
                  onClick={() => session.channels.refresh?.(channelId)}
                >
                  Refresh loaded history
                </Button>
              )}
              {window.hasMore && !window.historyLimited && (
                <Button
                  variant="link"
                  size="sm"
                  disabled={loading || window.loadingOlder}
                  onClick={() => session.channels.loadOlder(channelId)}
                >
                  Load older history
                </Button>
              )}
            </div>
          </details>
          {window.historyLimited && (
            <p role="status">Loaded history reached its retention limit.</p>
          )}
        </>
      }
    />
  );
}
