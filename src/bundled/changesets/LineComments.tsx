import type { SelectedLineRange } from "@pierre/diffs";
import {
  type FormEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { DiffViewer } from "../diffs/DiffViewer";
import type { FileData } from "../diffs/parse";
import type { Comments, LineComment } from "./comments";
import styles from "./Changesets.module.css";

type Change = FileData["hunks"][number]["changes"][number];
type Side = LineComment["at"]["side"];

const newLine = (change: Change) =>
  change.type === "normal"
    ? change.newLineNumber
    : change.type === "insert"
      ? change.lineNumber
      : -1;
const oldLine = (change: Change) =>
  change.type === "normal"
    ? change.oldLineNumber
    : change.type === "delete"
      ? change.lineNumber
      : -1;

/** Where `changes` sit: in the file as it is now, or, when they were all
 * removed, as it was. */
export function describeLines(changes: readonly Change[]): string {
  const now = changes.map(newLine).filter((line) => line > 0);
  const numbers = now.length
    ? now
    : changes.map(oldLine).filter((line) => line > 0);
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  const span = low === high ? `line ${low}` : `lines ${low}-${high}`;
  return now.length ? span : `removed ${span}`;
}

/** The changes a selected range covers, top to bottom. */
export function changesIn(
  changes: readonly Change[],
  range: SelectedLineRange,
): Change[] {
  const find = (line: number, side: Side) =>
    changes.findIndex(
      (change) => (side === "deletions" ? oldLine : newLine)(change) === line,
    );
  const from = find(range.start, range.side ?? "additions");
  const to = find(range.end, range.endSide ?? range.side ?? "additions");
  if (from < 0 || to < 0) return [];
  return changes.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** The line a comment on `changes` sits under. */
const anchorOf = (change: Change): LineComment["at"] =>
  change.type === "delete"
    ? { side: "deletions", line: change.lineNumber }
    : { side: "additions", line: newLine(change) };

const marker = (change: Change) =>
  change.type === "insert" ? "+" : change.type === "delete" ? "-" : " ";

/** One file's diff whose lines take comments: choose a line number, drag or
 * Shift-click to cover more, or use the add button beside a line. Each
 * comment goes to the agent as soon as it is made. */
export function CommentableDiff({
  content,
  files,
  path,
  comments,
  draft,
  send,
}: {
  content: string;
  files: FileData[] | undefined;
  path: string;
  comments: Comments;
  /** The changeset the comments belong to. */
  draft: string;
  /** Sends a comment to the agent; throws with the reason it could not. */
  send(comment: Omit<LineComment, "id">): void;
}) {
  const saved = useSyncExternalStore(comments.subscribe, () =>
    comments.list(draft),
  );
  const changes = useMemo(
    () => files?.flatMap((file) => file.hunks.flatMap((hunk) => hunk.changes)),
    [files],
  );
  const [pick, setPick] = useState<SelectedLineRange | null>(null);
  // What the open field holds, kept here so moving it to a wider range keeps
  // it without each keystroke rendering the diff again.
  const typed = useRef("");
  const [failure, setFailure] = useState<string>();
  if (!files || !changes?.length)
    return <DiffViewer content={content} files={files} filePath={path} />;
  const picked = pick ? changesIn(changes, pick) : [];
  const last = picked.at(-1);
  const cancel = () => {
    setPick(null);
    setFailure(undefined);
    typed.current = "";
  };
  const add = () => {
    const text = typed.current;
    if (!last || !text.trim()) return;
    const comment = {
      path,
      at: anchorOf(last),
      lines: describeLines(picked),
      code: picked.map((change) => `${marker(change)}${change.content}`),
      text: text.trim(),
    };
    try {
      send(comment);
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "Couldn't send the comment.",
      );
      return;
    }
    comments.add(draft, comment);
    cancel();
  };
  const mine = saved.filter((comment) => comment.path === path);
  const lineAnnotations = mine.map((comment) => ({
    side: comment.at.side,
    lineNumber: comment.at.line,
    metadata: comment.id,
  }));
  if (last) {
    const at = anchorOf(last);
    lineAnnotations.push({
      side: at.side,
      lineNumber: at.line,
      metadata: "new",
    });
  }
  return (
    <DiffViewer
      content={content}
      files={files}
      filePath={path}
      annotate={{
        lineAnnotations,
        renderAnnotation: ({ metadata }) => {
          const comment = mine.find((each) => each.id === metadata);
          return (
            <div className={styles.thread}>
              {comment ? (
                <SentComment comment={comment} />
              ) : metadata === "new" && picked.length ? (
                <NewComment
                  label={`Comment on ${describeLines(picked)}`}
                  typed={typed}
                  failure={failure}
                  cancel={cancel}
                  add={add}
                />
              ) : null}
            </div>
          );
        },
        selectedLines: pick,
        onSelect: (range) => {
          setFailure(undefined);
          setPick(range && changesIn(changes, range).length ? range : null);
        },
      }}
    />
  );
}

function NewComment({
  label,
  typed,
  failure,
  cancel,
  add,
}: {
  label: string;
  typed: { current: string };
  failure: string | undefined;
  cancel(): void;
  add(): void;
}) {
  const [empty, setEmpty] = useState(!typed.current.trim());
  return (
    <form
      className={styles.card}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        add();
      }}
    >
      <Field
        label={label}
        description="Posted in this chat for the agent, with the lines it points at."
        error={failure}
      >
        <Textarea
          autoFocus
          rows={3}
          defaultValue={typed.current}
          placeholder="What should the agent change?"
          onChange={(event) => {
            typed.current = event.target.value;
            setEmpty(!typed.current.trim());
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              cancel();
            } else if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              add();
            }
          }}
        />
      </Field>
      <div className={styles.actions}>
        <Button size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={empty}>
          Send
        </Button>
      </div>
    </form>
  );
}

function SentComment({ comment }: { comment: LineComment }) {
  return (
    <section className={styles.card} aria-label={`Comment on ${comment.lines}`}>
      <span className={styles.note}>{comment.lines}</span>
      <p className={styles.commentText}>{comment.text}</p>
    </section>
  );
}
