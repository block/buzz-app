import { useEffect, useMemo, useRef, useState } from "react";
import { CodeFile, codeLanguage, type LineRange } from "../diffs/CodeFile";
import {
  ArrowSquareOutIcon,
  FileCodeIcon,
} from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  PopoverPopup,
  PopoverRoot,
  PopoverTrigger,
} from "../../shared/design-system/ui/Popover";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import {
  parseCodeLink,
  type Code,
  type CodeLink,
  type CodeReader,
  type Thread,
} from "./code";
import type { GitHubComment, ReviewComment } from "./gh";
import { readable } from "./object";
import styles from "./CodePreview.module.css";

const span = ({ start, end }: LineRange) =>
  start === end ? `line ${start}` : `lines ${start}–${end}`;

/** The file a link names, read when `enabled`. `reload` reads it again,
 * keeping what is shown if that fails. */
function useCode(reader: CodeReader, link: CodeLink, enabled: boolean) {
  const [code, setCode] = useState<Code | Error>();
  const alive = useRef(true);
  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    reader.read(link).then(
      (read) => alive.current && setCode(read),
      (failure) => alive.current && setCode(readable(failure)),
    );
    return () => {
      alive.current = false;
    };
  }, [reader, link, enabled]);
  const reload = () => {
    reader.forget(link);
    reader.read(link).then(
      (read) => alive.current && setCode(read),
      () => {},
    );
  };
  return { code, reload };
}

/** A card for a GitHub link to code: the lines it names, highlighted, and the
 * whole file in a viewer. A pull request's lines also take review comments. */
export function CodePreview({
  url,
  reader,
  comment,
}: {
  url: string;
  reader: CodeReader;
  comment: GitHubComment | undefined;
}) {
  const link = useMemo(() => parseCodeLink(url), [url]);
  return link ? (
    <CodeCard url={url} link={link} reader={reader} comment={comment} />
  ) : null;
}

function CodeCard({
  url,
  link,
  reader,
  comment,
}: {
  url: string;
  link: CodeLink;
  reader: CodeReader;
  comment: GitHubComment | undefined;
}) {
  const lines = link.lines;
  const [open, setOpen] = useState(false);
  const { code, reload } = useCode(reader, link, !!lines || open);
  const [selected, setSelected] = useState<LineRange | null>(lines ?? null);
  const trigger = useRef<HTMLButtonElement>(null);
  const read = code instanceof Error ? undefined : code;
  // Until it is read, a blob link's first segment is taken as its ref.
  const path =
    read?.path ??
    (link.kind === "blob" ? link.segments.slice(1).join("/") : undefined);
  const name = path?.split("/").at(-1) ?? "";
  const language = path ? codeLanguage(path) : undefined;
  const source =
    link.kind === "blob"
      ? `${link.repository}@${read?.ref ?? link.segments[0]}`
      : `${link.repository}#${link.number} · ${link.side === "RIGHT" ? "head" : "base"}`;
  const count = read ? read.text.replace(/\r?\n$/, "").split("\n").length : 0;
  const excerpt =
    read && lines && lines.start <= count
      ? { start: lines.start, end: Math.min(lines.end, count) }
      : undefined;
  const failure = code instanceof Error && (
    <p role="alert" className={styles.notice}>
      {code.message}{" "}
      <a href={url} target="_blank" rel="noreferrer">
        Open on GitHub <ArrowSquareOutIcon size={14} aria-hidden="true" />
      </a>
    </p>
  );
  return (
    <section
      className={styles.card}
      aria-label={`Code: ${path ?? "pull request file"}`}
    >
      <header className={styles.header}>
        <FileCodeIcon size={16} aria-hidden="true" className={styles.icon} />
        <div className={styles.identity}>
          <span className={styles.path} title={path}>
            {path ?? "Pull request file"}
          </span>
          <span className={styles.meta}>
            {source}
            {language && ` · ${language === "text" ? "Plain text" : language}`}
            {lines && ` · ${span(lines)}`}
          </span>
        </div>
      </header>
      {lines && (
        <div className={styles.body}>
          <LoadingRegion
            pending={code === undefined}
            label="Loading code from GitHub…"
            feedback={failure || undefined}
            statusVisibility="screen-reader"
          >
            {read &&
              (excerpt ? (
                <div className={styles.excerpt}>
                  <CodeFile
                    name={read.path}
                    contents={read.text}
                    label={`${read.path} ${span(excerpt)}`}
                    lines={excerpt}
                    {...(read.pull && { selected, onSelect: setSelected })}
                  />
                </div>
              ) : (
                <p className={styles.notice}>
                  This file no longer has {span(lines)}.
                </p>
              ))}
          </LoadingRegion>
        </div>
      )}
      {read?.pull && excerpt && (
        <Threads
          threads={read.pull.threads.filter(
            (thread) =>
              link.kind === "pull" &&
              thread.side === link.side &&
              thread.startLine <= excerpt.end &&
              thread.line >= excerpt.start,
          )}
        />
      )}
      <div className={styles.actions}>
        <Button
          ref={trigger}
          size="sm"
          onClick={() => setOpen(true)}
          disabled={!!lines && !read}
        >
          {lines ? "Open in viewer" : "Open file"}
        </Button>
        {link.kind === "pull" && read?.pull && comment && selected && (
          <CommentButton
            link={link}
            head={read.pull.head}
            path={read.path}
            lines={selected}
            comment={comment}
            posted={reload}
          />
        )}
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={path ?? "Pull request file"}
        description={source}
        size="expanded"
        closeLabel="Close file"
        finalFocus={trigger}
      >
        {read ? (
          <CodeFile
            name={read.path}
            contents={read.text}
            label={name}
            selected={lines && excerpt}
            scrollToSelected
          />
        ) : (
          <LoadingRegion
            pending={code === undefined}
            label="Loading file from GitHub…"
            feedback={failure || undefined}
          >
            {null}
          </LoadingRegion>
        )}
      </Dialog>
    </section>
  );
}

function Threads({ threads }: { threads: readonly Thread[] }) {
  if (!threads.length) return null;
  return (
    <ul className={styles.threads} aria-label="Review comments on these lines">
      {threads.flatMap((thread) =>
        thread.comments.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: A thread's comments keep their order.
          <li key={`${thread.startLine}-${thread.line}-${index}`}>
            <span className={styles.author}>{item.author}</span>{" "}
            <span className={styles.meta}>
              {span({ start: thread.startLine, end: thread.line })}
            </span>
            <p>{item.body}</p>
          </li>
        )),
      )}
    </ul>
  );
}

/** The review comment GitHub takes for `lines` of the file at `head`. */
export function reviewComment(
  link: Extract<CodeLink, { kind: "pull" }>,
  head: string,
  path: string,
  lines: LineRange,
  body: string,
): ReviewComment {
  return {
    body,
    commit_id: head,
    path,
    line: lines.end,
    side: link.side,
    ...(lines.start < lines.end && {
      start_line: lines.start,
      start_side: link.side,
    }),
  };
}

/** Writes and posts one review comment. Nothing goes to GitHub until the
 * person chooses Post comment. */
function CommentButton({
  link,
  head,
  path,
  lines,
  comment,
  posted,
}: {
  link: Extract<CodeLink, { kind: "pull" }>;
  head: string;
  path: string;
  lines: LineRange;
  comment: GitHubComment;
  posted(): void;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const field = useRef<HTMLTextAreaElement>(null);
  const notify = useToastNotification();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function submit() {
    if (busy || !body.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await comment(
        { repository: link.repository, number: link.number },
        reviewComment(link, head, path, lines, body),
      );
      if (!alive.current) return;
      setOpen(false);
      setBody("");
      notify("Comment posted", "success");
      posted();
    } catch (failure) {
      if (alive.current) setError(readable(failure).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (next) setError(undefined);
      }}
    >
      <PopoverTrigger
        render={<Button size="sm">Comment on {span(lines)}</Button>}
      />
      <PopoverPopup
        align="start"
        size="wide"
        aria-label="Review comment"
        initialFocus={field}
      >
        <form
          className={styles.form}
          onSubmit={(submitted) => {
            submitted.preventDefault();
            void submit();
          }}
        >
          <Field
            label={`Comment on ${span(lines)}`}
            description={`Posts a review comment on ${path} to ${link.repository}#${link.number}, as your GitHub account.`}
          >
            <Textarea
              ref={field}
              rows={4}
              aria-required
              value={body}
              disabled={busy}
              onChange={(change) => setBody(change.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <div className={styles.formActions}>
            <Button disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="prominent"
              type="submit"
              loading={busy}
              disabled={!body.trim()}
              focusableWhenDisabled
            >
              Post comment
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </PopoverRoot>
  );
}
