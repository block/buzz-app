import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { Select } from "../../shared/design-system/ui/Select";
import {
  DiffViewer,
  type DiffComments,
  type DiffLine,
} from "../diffs/DiffViewer";
import { parsePatch } from "../diffs/parse";
import { GitHubComment } from "./GitHubComment";
import {
  anchorInSnapshot,
  type Anchor,
  type PrComments,
  type PullRef,
  type Snapshot,
  type Thread,
} from "./pr-comments";
import { readable } from "./object";
import styles from "./InlineComments.module.css";

const rowKey = (path: string, side: string, line: number) =>
  JSON.stringify([path, side, line]);
export function PrFiles({
  api,
  pull,
  head,
  base,
}: {
  api: PrComments;
  pull: PullRef;
  head: string;
  base: string;
  active?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const snapshotRef = useRef<Snapshot | undefined>(undefined);
  const threadVersion = useRef(0);
  const [threads, setThreads] = useState<readonly Thread[]>([]);
  const [error, setError] = useState<string>();
  const [threadError, setThreadError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [available, setAvailable] = useState<ReadonlySet<string>>(new Set());
  const refreshButton = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const availability = useCallback((path: string, ready: boolean) => {
    setAvailable((previous) => {
      if (previous.has(path) === ready) return previous;
      const next = new Set(previous);
      if (ready) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);
  const readThreads = useCallback(
    async (current: Snapshot, signal?: AbortSignal) => {
      const result: Thread[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await api.loadThreads(current, cursor, signal);
        if (page.head !== current.head || page.base !== current.base)
          throw new Error(
            "PR changed while loading comments; refresh changes.",
          );
        result.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor))
          throw new Error("GitHub repeated a comment page; refresh changes.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return result;
    },
    [api],
  );
  const { repository, number } = pull;
  // biome-ignore lint/correctness/useExhaustiveDependencies: PR revisions and explicit refresh invalidate the remote snapshot.
  useEffect(() => {
    const controller = new AbortController();
    const version = ++threadVersion.current;
    snapshotRef.current = undefined;
    setSnapshot(undefined);
    setAvailable(new Set());
    setLoading(true);
    setCommentsLoading(true);
    setError(undefined);
    setThreads([]);
    void api
      .loadSnapshot({ repository, number }, controller.signal)
      .then(
        async (current) => {
          if (controller.signal.aborted) return;
          snapshotRef.current = current;
          setSnapshot(current);
          setLoading(false);
          try {
            const rows = await readThreads(current, controller.signal);
            if (
              !controller.signal.aborted &&
              threadVersion.current === version
            ) {
              setThreads(rows);
              setThreadError(undefined);
            }
          } catch (failure) {
            if (!controller.signal.aborted && threadVersion.current === version)
              setThreadError(readable(failure).message);
          }
        },
        (failure) => {
          if (!controller.signal.aborted) setError(readable(failure).message);
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (threadVersion.current === version) setCommentsLoading(false);
        }
      });
    return () => controller.abort();
  }, [api, repository, number, head, base, revision, readThreads]);
  const parts = useMemo(
    () =>
      snapshot?.diff
        .split(/^(?=diff --git )/m)
        .filter((part) => part.trim())
        .map((content) => ({ content, files: parsePatch(content) })),
    [snapshot],
  );
  const mapped = useCallback(
    (thread: Thread) =>
      !!snapshot &&
      !loading &&
      !thread.outdated &&
      thread.line !== null &&
      available.has(thread.path) &&
      anchorInSnapshot(snapshot, {
        ...thread,
        line: thread.line,
        head: snapshot.head,
        base: snapshot.base,
      }),
    [snapshot, loading, available],
  );
  const more = useCallback(
    async (thread: Thread) => {
      if (!thread.commentsCursor || !snapshot) return;
      const current = snapshot;
      try {
        const page = await api.loadComments(thread.id, thread.commentsCursor);
        const owning = page.thread;
        if (
          page.pullId !== current.pullId ||
          page.head !== current.head ||
          page.base !== current.base ||
          owning.id !== thread.id ||
          owning.path !== thread.path ||
          owning.side !== thread.side ||
          owning.rootCommentId !== thread.rootCommentId ||
          owning.line !== thread.line ||
          owning.outdated !== thread.outdated
        )
          throw new Error("Thread changed; refresh changes.");
        if (alive.current && snapshotRef.current === current)
          setThreads((previous) =>
            previous.map((row) =>
              row.id === thread.id &&
              row.commentsCursor === thread.commentsCursor
                ? {
                    ...row,
                    comments: [
                      ...row.comments,
                      ...page.items.filter(
                        (comment) =>
                          !row.comments.some(
                            (existing) => existing.id === comment.id,
                          ),
                      ),
                    ],
                    commentsComplete: !page.nextCursor,
                    commentsCursor: page.nextCursor,
                  }
                : row,
            ),
          );
      } catch (failure) {
        if (alive.current && snapshotRef.current === current)
          setThreadError(readable(failure).message);
      }
    },
    [snapshot, api],
  );
  const threadView = useCallback(
    (thread: Thread, inline = false) => {
      return (
        <section
          key={thread.id}
          className={styles.thread}
          aria-label={`Comments on ${thread.path}`}
        >
          {!inline && (
            <p>
              {thread.path} ·{" "}
              {thread.outdated
                ? "Outdated"
                : thread.line === null
                  ? "Not on a displayed line"
                  : `${thread.side === "LEFT" ? "Old" : "New"} line ${thread.line}`}
              {thread.resolved ? " · Resolved" : ""}
            </p>
          )}
          {thread.comments.map((comment) => (
            <GitHubComment key={comment.id} comment={comment} />
          ))}
          <div className={styles.actions}>
            {!thread.commentsComplete && (
              <Button size="sm" onClick={() => void more(thread)}>
                Load more replies
              </Button>
            )}
          </div>
        </section>
      );
    },
    [more],
  );
  const renderedThreads = useMemo(
    () =>
      threads.map((thread) => {
        const inline = mapped(thread);
        return { thread, inline, content: threadView(thread, inline) };
      }),
    [threads, mapped, threadView],
  );
  const annotations = new Map<
    string,
    {
      path: string;
      side: DiffLine["side"];
      lineNumber: number;
      content: ReactNode[];
    }
  >();
  function annotate(
    target: Pick<Anchor, "path" | "side" | "line">,
    content: ReactNode,
  ) {
    const key = rowKey(target.path, target.side, target.line);
    let row = annotations.get(key);
    if (!row) {
      row = {
        path: target.path,
        side: target.side === "LEFT" ? "deletions" : "additions",
        lineNumber: target.line,
        content: [],
      };
      annotations.set(key, row);
    }
    row.content.push(content);
  }
  for (const { thread, inline, content } of renderedThreads)
    if (inline && thread.line !== null)
      annotate({ ...thread, line: thread.line }, content);
  const comments: DiffComments = {
    annotations: [...annotations.values()],
    onAvailabilityChange: availability,
    readOnly: true,
    onSelect() {},
  };
  return (
    <div className={styles.files}>
      <div className={styles.actions}>
        <Button
          size="sm"
          ref={refreshButton}
          disabled={loading}
          onClick={() => setRevision((previous) => previous + 1)}
        >
          Refresh changes
        </Button>
        <Select
          label="Diff layout"
          value={layout}
          size="sm"
          groups={[
            {
              label: "Layout",
              options: [
                { value: "unified", label: "Unified" },
                { value: "split", label: "Split" },
              ],
            },
          ]}
          onValueChange={(value) =>
            setLayout(value === "split" ? "split" : "unified")
          }
        />
      </div>
      {error && <p role="alert">{error}</p>}
      {threadError && <p role="alert">{threadError}</p>}
      <LoadingRegion pending={loading} label="Loading GitHub changes…">
        {parts?.map((part) => (
          <DiffViewer
            key={part.content.split("\n", 1)[0]}
            content={part.content}
            files={part.files}
            viewType={layout}
            comments={comments}
          />
        ))}
        {parts?.length === 0 && <p>No file changes.</p>}
      </LoadingRegion>
      <LoadingRegion pending={commentsLoading} label="Loading comments…">
        {renderedThreads
          .filter((entry) => !entry.inline)
          .map((entry) => entry.content)}
      </LoadingRegion>
    </div>
  );
}
