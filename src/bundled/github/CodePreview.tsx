import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { LinkLabelContext } from "../../features/conversation/LinkLabelContext";
import type { LinkPreviewProps } from "../../features/conversation/contracts";
import type { PanelProps } from "../../features/panels/service";
import { usePanelTabTitle } from "../../features/panels/PanelWorkspace";
import { CodeFile, type LineRange } from "../diffs/CodeFile";
import {
  ArrowSquareOutIcon,
  ArrowsOutIcon,
  ChatCircleIcon,
  FileCodeIcon,
  GitBranchIcon,
  GitCommitIcon,
} from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import inlineStyles from "../../shared/InlineReference.module.css";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  PopoverPopup,
  PopoverRoot,
  PopoverTrigger,
} from "../../shared/design-system/ui/Popover";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { LinkLabel } from "../links/InlineLink";
import {
  isCommit,
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

/** The file a link names. `reload` reads it again, keeping what is shown if
 * that fails. */
function useCode(reader: CodeReader, link: CodeLink) {
  const [code, setCode] = useState<Code | Error>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    reader.read(link).then(
      (read) => alive.current && setCode(read),
      (failure) => alive.current && setCode(readable(failure)),
    );
    return () => {
      alive.current = false;
    };
  }, [reader, link]);
  const reload = () => {
    reader.forget(link);
    reader.read(link).then(
      (read) => alive.current && setCode(read),
      () => {},
    );
  };
  return { code, reload };
}

const lineCount = (text: string) =>
  text.replace(/\r?\n$/, "").split("\n").length;

/** A blob link to `lines` of `path` at `ref`, which the file panel opens. */
export const blobUrl = (
  repository: string,
  ref: string,
  path: string,
  lines: LineRange,
) =>
  `https://github.com/${repository}/blob/${ref}/${path}#L${lines.start}${lines.end > lines.start ? `-L${lines.end}` : ""}`;

/** A file's path, cut from the left when narrow so its name stays. */
function FilePath({ path, repository }: { path: string; repository?: string }) {
  const slash = path.lastIndexOf("/") + 1;
  return (
    <span className={styles.path} title={path}>
      <bdi>
        {repository && `${repository} · `}
        {path.slice(0, slash)}
        <b>{path.slice(slash)}</b>
      </bdi>
    </span>
  );
}

/** The branch, tag or commit the code is read at. */
function RefChip({ name }: { name: string }) {
  const commit = isCommit(name);
  const Icon = commit ? GitCommitIcon : GitBranchIcon;
  return (
    <span
      className={styles.ref}
      title={commit ? `Commit ${name}` : `Branch ${name}`}
    >
      <Icon size={12} aria-hidden="true" />
      <span>{commit ? name.slice(0, 7) : name}</span>
    </span>
  );
}

/** Opens `href` on GitHub, in the browser. */
function OnGitHub({ href, label }: { href: string; label: string }) {
  return (
    <Button
      size="xs"
      variant="subtle"
      nativeButton={false}
      role="link"
      render={<a href={href} target="_blank" rel="noreferrer" />}
    >
      {label} <ArrowSquareOutIcon size={14} aria-hidden="true" />
    </Button>
  );
}

/** A code link in a message, named by its file and lines instead of its URL.
 * An authored label stays. */
export function CodeLinkLabel({ url }: { url: string }) {
  const authored = useContext(LinkLabelContext) !== undefined;
  const link = parseCodeLink(url);
  // Until it is read, a blob link's last segment is its file name.
  const name = link?.kind === "blob" ? link.segments.at(-1) : undefined;
  const lines = link?.lines;
  return (
    <LinkLabel
      href={url}
      {...(!authored &&
        name && {
          label: lines
            ? `${name}:${lines.start}${lines.end > lines.start ? `–${lines.end}` : ""}`
            : name,
        })}
      icon={<FileCodeIcon aria-hidden="true" className={inlineStyles.icon} />}
    />
  );
}

/** The lines a link names, drawn inside its message like a code block. A
 * pull request's lines also take review comments. */
export function CodeExcerpt({
  url,
  open,
  opener,
  reader,
  comment,
}: LinkPreviewProps & {
  reader: CodeReader;
  comment: GitHubComment | undefined;
}) {
  const link = useMemo(() => parseCodeLink(url), [url]);
  return link?.lines ? (
    <Excerpt
      url={url}
      link={link}
      lines={link.lines}
      open={open}
      opener={opener}
      reader={reader}
      comment={comment}
    />
  ) : null;
}

function Excerpt({
  url,
  link,
  lines,
  open,
  opener,
  reader,
  comment,
}: Pick<LinkPreviewProps, "url" | "open" | "opener"> & {
  link: CodeLink;
  lines: LineRange;
  reader: CodeReader;
  comment: GitHubComment | undefined;
}) {
  const { code, reload } = useCode(reader, link);
  const [selected, setSelected] = useState<LineRange | null>(lines);
  // Nothing shows while it loads: the link above already says what it is.
  if (code === undefined) return null;
  if (code instanceof Error)
    return (
      <p className={styles.notice}>Can’t show these lines: {code.message}</p>
    );
  const read = code;
  const count = lineCount(read.text);
  if (lines.start > count)
    return (
      <p className={styles.notice}>This file no longer has {span(lines)}.</p>
    );
  const excerpt = { start: lines.start, end: Math.min(lines.end, count) };
  const threads =
    read.pull && link.kind === "pull"
      ? read.pull.threads.filter(
          (thread) =>
            thread.side === link.side &&
            thread.startLine <= excerpt.end &&
            thread.line >= excerpt.start,
        )
      : [];
  const full = blobUrl(
    link.repository,
    read.ref,
    read.path,
    selected ?? excerpt,
  );
  const marked = threads.map((thread) => thread.line);
  return (
    <div className={styles.frame}>
      <div className={styles.bar}>
        <FilePath path={read.path} />
        <span className={styles.where}>
          <span className={styles.meta}>{span(excerpt)}</span>
          <RefChip name={read.pull?.branch ?? read.ref} />
        </span>
        <span className={styles.buttons}>
          {link.kind === "pull" && read.pull && comment && selected && (
            <CommentButton
              link={link}
              head={read.pull.head}
              path={read.path}
              lines={selected}
              comment={comment}
              posted={reload}
            />
          )}
          <OnGitHub href={url} label="GitHub" />
          <IconButton
            aria-label="Open file"
            title="Open file"
            icon={<ArrowsOutIcon />}
            // A pull request link opens the pull request, so its file opens as
            // a file link at the commit shown.
            onClick={() => (link.kind === "blob" ? open() : opener?.open(full))}
          />
        </span>
      </div>
      <div className={styles.code}>
        <CodeFile
          name={read.path}
          contents={read.text}
          label={`${read.path} ${span(excerpt)}`}
          lines={excerpt}
          marked={marked}
          {...(read.pull && { selected, onSelect: setSelected })}
        />
      </div>
      <Threads threads={threads} />
    </div>
  );
}

/** A whole file in a side panel, scrolled to the lines its link names. */
export function CodePanel({
  target,
  reader,
}: PanelProps & { reader: CodeReader }) {
  // The panel matches only code links.
  const link = useMemo(() => parseCodeLink(target) as CodeLink, [target]);
  const { code } = useCode(reader, link);
  const read = code instanceof Error ? undefined : code;
  const name =
    read?.path.split("/").at(-1) ??
    (link.kind === "blob" ? link.segments.at(-1) : undefined) ??
    "File";
  usePanelTabTitle(name);
  return (
    <div className={styles.panel}>
      <div className={styles.sticky}>
        <FilePath path={read?.path ?? name} repository={link.repository} />
        {read && <RefChip name={read.ref} />}
        <span className={styles.buttons}>
          <OnGitHub href={target} label="Open on GitHub" />
        </span>
      </div>
      <LoadingRegion
        pending={code === undefined}
        label="Loading file from GitHub…"
        // The sticky bar already names the file, so loading reserves no row.
        statusVisibility="screen-reader"
        feedback={
          code instanceof Error ? (
            <p role="alert" className={styles.notice}>
              {code.message}
            </p>
          ) : undefined
        }
      >
        {read && (
          <CodeFile
            name={read.path}
            contents={read.text}
            label={read.path}
            selected={link.lines}
            scrollToSelected
          />
        )}
      </LoadingRegion>
    </div>
  );
}

function Threads({ threads }: { threads: readonly Thread[] }) {
  if (!threads.length) return null;
  return (
    <ul className={styles.threads} aria-label="Review comments on these lines">
      {threads.flatMap((thread) =>
        thread.comments.map((item, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: A thread's comments keep their order.
            key={`${thread.startLine}-${thread.line}-${index}`}
            className={styles.comment}
          >
            {item.avatar && (
              <Avatar
                src={item.avatar}
                alt=""
                fallback={item.author}
                size="tiny"
              />
            )}
            <div className={styles.said}>
              <span className={styles.author}>{item.author}</span>
              <p>{item.body}</p>
            </div>
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
  const label = `Comment on ${span(lines)}`;
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
        render={
          <IconButton
            aria-label={label}
            title={label}
            icon={<ChatCircleIcon />}
          />
        }
      />
      <PopoverPopup
        align="end"
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
            label={label}
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
