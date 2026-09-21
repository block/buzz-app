import type { ReactNode } from "react";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import styles from "./SessionsDirectory.module.css";

export type ThreadPreviewRow = Readonly<{
  rootId: string;
  title: string;
  replyCount: number;
  startedAt: number;
}>;

/** Presentation of positively classified loaded agent threads, not a complete directory. */
export function SessionsDirectory({
  openThread,
  rows,
  now,
  controls,
  showEmpty = true,
}: {
  openThread(rootId: string): boolean;
  rows: readonly ThreadPreviewRow[];
  now: number;
  controls?: ReactNode;
  showEmpty?: boolean;
}) {
  const today = new Date(now * 1000);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<string, ThreadPreviewRow[]>();
  const sorted = [...rows].sort(
    (a, b) =>
      b.startedAt - a.startedAt ||
      (a.rootId < b.rootId ? -1 : a.rootId > b.rootId ? 1 : 0),
  );
  for (const row of sorted) {
    const date = new Date(row.startedAt * 1000);
    const label =
      date >= today
        ? "Today"
        : date >= yesterday
          ? "Yesterday"
          : date.toLocaleDateString(undefined, {
              month: "long",
              day: "numeric",
              year: "numeric",
            });
    const group = groups.get(label) ?? [];
    group.push(row);
    groups.set(label, group);
  }
  return (
    <section data-buzz-ui="" className={styles.directory} aria-label="Sessions">
      <div className={styles.intro}>
        <h2>Sessions</h2>
        <p>Threads that mention or include an agent. Showing loaded history.</p>
        <p>
          Ordered by thread start, not the latest reply. Later replies are
          sampled; some sessions may be missing.
        </p>
      </div>
      {controls}
      {!sorted.length && showEmpty && (
        <p className={styles.empty}>
          No agent sessions found in the checked history
        </p>
      )}
      {[...groups].map(([label, entries]) => (
        <section
          key={label}
          aria-label={`Started ${label}`}
          className={styles.group}
        >
          <h3>Started {label}</h3>
          <ul>
            {entries.map((row) => (
              <li key={row.rootId}>
                <button
                  type="button"
                  id={`session-row-${row.rootId}`}
                  className={styles.row}
                  onClick={() => openThread(row.rootId)}
                >
                  <ChatCircleIcon size={20} aria-hidden="true" />
                  <span className={styles.text}>
                    <strong>{row.title}</strong>
                    <span>
                      {row.replyCount}{" "}
                      {row.replyCount === 1 ? "reply" : "replies"}
                    </span>
                  </span>
                  <time dateTime={new Date(row.startedAt * 1000).toISOString()}>
                    Started{" "}
                    {new Date(row.startedAt * 1000).toLocaleTimeString(
                      undefined,
                      { hour: "numeric", minute: "2-digit" },
                    )}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
