import { useCallback, useId, useSyncExternalStore } from "react";
import type { ChannelThreadSidebarProps } from "../../features/conversation/contracts";
import type { createRetainedSessions } from "./retained-sessions";
import { SessionActivity } from "./SessionActivity";
import { SessionUnread } from "./SessionUnread";
import styles from "./PersonalSessions.module.css";

export function PersonalSessions({
  session,
  channelId,
  channelName,
  selectedRootId,
  directorySelected,
  openThread,
  openDirectory,
  owner,
}: ChannelThreadSidebarProps & {
  owner: ReturnType<typeof createRetainedSessions>;
}) {
  const evidence = owner.forSession(session);
  const snapshot = useCallback(
    () => evidence.snapshot(channelId),
    [evidence, channelId],
  );
  const rows = useSyncExternalStore(evidence.subscribe, snapshot, snapshot);
  const description = useId();
  const supported =
    !!session.channels.retained && !!session.channels.subscribeRetained;
  return (
    <section
      data-buzz-ui=""
      className={styles.children}
      aria-label={`Your sessions in ${channelName}`}
    >
      {rows.map((row) => (
        <button
          key={row.rootId}
          type="button"
          id={`personal-session-${channelId}-${row.rootId}`}
          className={styles.row}
          title={row.title}
          aria-current={selectedRootId === row.rootId ? "page" : undefined}
          onClick={() => openThread(row.rootId)}
        >
          <span className={styles.branch} aria-hidden="true" />
          <span className={styles.title}>{row.title}</span>
          <SessionActivity
            compact
            evidence={evidence}
            channelId={channelId}
            rootId={row.rootId}
          />
          <SessionUnread
            unread={session.unread}
            channelId={channelId}
            rootId={row.rootId}
          />
        </button>
      ))}
      <button
        type="button"
        className={styles.all}
        title={
          supported
            ? "From loaded history · may be incomplete"
            : "Loaded session preview unavailable"
        }
        aria-describedby={description}
        aria-current={directorySelected && !selectedRootId ? "page" : undefined}
        onClick={openDirectory}
      >
        View all sessions
      </button>
      <p id={description} className="sr-only">
        {supported
          ? "From loaded history · may be incomplete"
          : "Loaded session preview unavailable"}
      </p>
    </section>
  );
}
