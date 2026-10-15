// Dormant (plan §1.2): no screen mounts this until config sync (PR C) ships.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RelayEvent } from "../relay/events";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import {
  artifactOp,
  type Expected,
  type SnapshotRead,
} from "./agent-config-artifacts";
import {
  emptyHistory,
  type Gap,
  HISTORY_LIMIT,
  type History,
  lineDiff,
  loadOlder,
  revertTemplate,
  segments,
  settingsDiff,
} from "./agent-config-history";
import styles from "./AgentConfigHistory.module.css";

const GAP_TEXT: Record<Gap, string> = {
  unloaded: "Older revisions aren't loaded yet.",
  capped: `Older history isn't available from this relay (limit ${HISTORY_LIMIT.toLocaleString("en-US")} revisions).`,
  failed: "Couldn't load older revisions.",
  unavailable: "A revision here isn't available (removed or expired).",
};

/** The text a person edits, for the line diff. */
function text(expected: Expected, event: RelayEvent) {
  try {
    const value = JSON.parse(event.content) as Record<string, unknown>;
    const field = expected.type === "buzz.team" ? "instructions" : "text";
    return typeof value[field] === "string" ? value[field] : "";
  } catch {
    return "";
  }
}

export function AgentConfigHistory({
  expected,
  head,
  read,
  onRevert,
}: {
  expected: Expected;
  /** The current head from the config store; revert builds on it. */
  head: RelayEvent | undefined;
  read: SnapshotRead;
  onRevert(template: ReturnType<typeof revertTemplate>): Promise<void>;
}) {
  const [history, setHistory] = useState<History>(emptyHistory);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string>();
  const [reverting, setReverting] = useState<string>();
  const live = useRef(history);
  live.current = history;
  const signal = useRef<AbortController>(undefined);

  const more = useCallback(async () => {
    signal.current ??= new AbortController();
    const controller = signal.current;
    setLoading(true);
    const next = await loadOlder(
      read,
      expected.d,
      live.current,
      controller.signal,
    );
    if (controller.signal.aborted) return;
    live.current = next;
    setHistory(next);
    setLoading(false);
  }, [read, expected.d]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A new head reloads history from the newest page.
  useEffect(() => {
    setHistory(emptyHistory);
    live.current = emptyHistory;
    void more();
    return () => {
      signal.current?.abort();
      signal.current = undefined;
    };
  }, [more, head?.id]);

  const revert = async (target: RelayEvent) => {
    if (!head) return;
    setReverting(target.id);
    try {
      await onRevert(revertTemplate(expected, head, target));
    } finally {
      setReverting(undefined);
    }
  };

  const gapAction = (gap: Gap) =>
    gap === "unloaded" || gap === "failed" ? (
      <Button size="sm" variant="subtle" loading={loading} onClick={more}>
        {gap === "failed" ? "Retry" : "Load older"}
      </Button>
    ) : null;

  const changes = (event: RelayEvent, before: RelayEvent | undefined) => {
    if (!before && artifactOp(event) !== "create")
      return (
        <p className="text-body-sm">
          The previous revision isn't loaded, so changes can't be shown.
        </p>
      );
    if (expected.type === "buzz.agent.settings") {
      const fields = settingsDiff(before?.content ?? "", event.content);
      return fields.length ? (
        <ul className={styles.diff} aria-label="Changes">
          {fields.map(({ field, before, after }) => (
            <li key={field}>
              {field}: {JSON.stringify(before) ?? "—"} →{" "}
              {JSON.stringify(after) ?? "—"}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body-sm">No setting changes.</p>
      );
    }
    return (
      // biome-ignore lint/a11y/useSemanticElements: The diff keeps preformatted lines and needs keyboard access.
      <pre
        className={styles.diff}
        role="region"
        aria-label="Changes"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll owner must support keyboard panning.
        tabIndex={0}
      >
        {lineDiff(
          before ? text(expected, before) : "",
          text(expected, event),
        ).map((line, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: Lines have no identity beyond position.
            key={index}
            className={
              line.type === "added"
                ? styles.added
                : line.type === "removed"
                  ? styles.removed
                  : undefined
            }
          >
            {line.type === "added"
              ? "+ "
              : line.type === "removed"
                ? "− "
                : "  "}
            {line.text}
          </div>
        ))}
      </pre>
    );
  };

  const all = segments(history);
  return (
    <section className={styles.history} aria-label="History">
      <InlineHeader title="History" />
      {!history.revisions.length && !history.failed && (
        <p className="text-body-sm">
          {loading ? "Loading history…" : "No revisions returned."}
        </p>
      )}
      {!history.revisions.length && history.failed && (
        <div className={styles.gap}>
          <span className={styles.label}>{GAP_TEXT.failed}</span>
          {gapAction("failed")}
        </div>
      )}
      {all.map((segment) => (
        <ol className={styles.list} key={segment.revisions[0]?.id}>
          {segment.revisions.map((event, index) => {
            const deleted = artifactOp(event) === "delete";
            const current = event.id === head?.id;
            return (
              <li className={styles.row} key={event.id}>
                <span className={styles.label}>
                  <span className="text-label">
                    {artifactOp(event)}
                    {current ? " · Current" : ""}
                  </span>{" "}
                  <span className="text-caption">
                    {new Date(event.created_at * 1000).toLocaleString()}
                  </span>
                </span>
                {!deleted && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={open === event.id}
                    onClick={() =>
                      setOpen(open === event.id ? undefined : event.id)
                    }
                  >
                    {open === event.id ? "Hide changes" : "Show changes"}
                  </Button>
                )}
                {!deleted &&
                  !current &&
                  head &&
                  artifactOp(head) !== "delete" && (
                    <Button
                      size="sm"
                      variant="subtle"
                      loading={reverting === event.id}
                      disabled={
                        reverting !== undefined && reverting !== event.id
                      }
                      onClick={() => revert(event)}
                    >
                      Revert to this
                    </Button>
                  )}
                {open === event.id &&
                  changes(event, segment.revisions[index + 1])}
              </li>
            );
          })}
          {segment.gap && (
            <li className={styles.gap}>
              <span className={styles.label}>{GAP_TEXT[segment.gap]}</span>
              {gapAction(segment.gap)}
            </li>
          )}
        </ol>
      ))}
    </section>
  );
}
