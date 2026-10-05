import type { ReactNode } from "react";
import styles from "./SessionsDirectory.module.css";

export type ThreadPreviewRow = Readonly<{
  rootId: string;
  title: string;
  preview?: ReactNode;
  avatar?: ReactNode;
  replyCount: number;
  lastMessageAt: number;
}>;

/** Presentation of positively classified loaded agent threads, not a complete directory. */
export function SessionsDirectory({
  openThread,
  rows,
  now,
  controls,
  showEmpty = true,
  renderStatus,
}: {
  openThread(rootId: string): boolean;
  rows: readonly ThreadPreviewRow[];
  now: number;
  controls?: ReactNode;
  showEmpty?: boolean;
  renderStatus?: (rootId: string) => ReactNode;
}) {
  const today = new Date(now * 1000);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const groups = new Map<string, ThreadPreviewRow[]>();
  const sorted = rows
    .filter(
      (row) =>
        row.lastMessageAt >= 0 &&
        Number.isFinite(new Date(row.lastMessageAt * 1000).getTime()),
    )
    .sort(
      (a, b) =>
        b.lastMessageAt - a.lastMessageAt ||
        (a.rootId < b.rootId ? -1 : a.rootId > b.rootId ? 1 : 0),
    );
  for (const row of sorted) {
    const date = new Date(row.lastMessageAt * 1000);
    const label =
      date >= today && date < tomorrow
        ? "Today"
        : date >= yesterday && date < today
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
      {!sorted.length && showEmpty && (
        <p className={styles.empty}>
          No agent sessions found in the checked history
        </p>
      )}
      <ul className={styles.list}>
        {/* Flat keyed children preserve each button across date-group changes. */}
        {[...groups].flatMap(([label, entries]) => [
          <li
            key={`date-${label}`}
            className={styles.group}
            role="presentation"
          >
            <h3>{label}</h3>
          </li>,
          ...entries.map((row) => (
            <li key={row.rootId}>
              <button
                type="button"
                id={`session-row-${row.rootId}`}
                className={styles.row}
                onClick={() => openThread(row.rootId)}
              >
                {row.avatar}
                <span className={styles.text}>
                  <span className={styles.preview}>
                    {row.preview ?? row.title}
                  </span>
                  <span className="sr-only">
                    {row.replyCount}{" "}
                    {row.replyCount === 1 ? "reply" : "replies"}
                  </span>
                </span>
                {renderStatus?.(row.rootId)}
                <time
                  dateTime={new Date(row.lastMessageAt * 1000).toISOString()}
                  title={`Last observed message ${new Date(row.lastMessageAt * 1000).toLocaleString()}`}
                >
                  {new Date(row.lastMessageAt * 1000).toLocaleTimeString(
                    undefined,
                    { hour: "numeric", minute: "2-digit" },
                  )}
                </time>
              </button>
            </li>
          )),
        ])}
      </ul>
      {controls && <footer className={styles.footer}>{controls}</footer>}
    </section>
  );
}
