import { useEffect, useMemo, useState } from "react";
import { PanelSubview } from "../../features/panels/PanelSubview";
import { ArrowSquareOutIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { DiffViewer } from "../diffs/DiffViewer";
import { parsePatch } from "../diffs/parse";
import type { GitHubDiff } from "./gh";
import { readable } from "./object";
import styles from "./GitHub.module.css";

type Pull = Readonly<{ repository: string; base: string; head: string }>;

/** One patch per file, so a file the parser cannot render falls back to raw
 * text without taking the rest of the diff with it. */
export function splitPatch(content: string): string[] {
  return content.split(/^(?=diff --git )/m).filter((part) => part.trim());
}

/** Opens the pull request's Files changed in a subview, and reports each head
 * whose diff it showed. */
export function PullFiles({
  url,
  pull,
  diff,
  onViewed,
}: {
  url: string;
  pull: Pull;
  diff: GitHubDiff;
  onViewed(head: string): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        View changes
      </Button>
      {open && (
        <PanelSubview
          title="Files changed"
          backLabel="Back to pull request"
          onBack={() => setOpen(false)}
        >
          <FilesChanged
            key={pull.head}
            url={url}
            pull={pull}
            diff={diff}
            onViewed={onViewed}
          />
        </PanelSubview>
      )}
    </>
  );
}

function FilesChanged({
  url,
  pull,
  diff,
  onViewed,
}: {
  url: string;
  pull: Pull;
  diff: GitHubDiff;
  onViewed(head: string): void;
}) {
  const { repository, base, head } = pull;
  const [result, setResult] = useState<string | Error>();
  useEffect(() => {
    const controller = new AbortController();
    diff({ repository, base, head }, controller.signal).then(
      (content) => {
        if (!controller.signal.aborted) setResult(content);
      },
      (failure) => {
        if (!controller.signal.aborted) setResult(readable(failure));
      },
    );
    return () => controller.abort();
  }, [diff, repository, base, head]);
  const parts = useMemo(
    () =>
      typeof result === "string"
        ? splitPatch(result).map((content) => ({
            content,
            files: parsePatch(content),
          }))
        : undefined,
    [result],
  );
  useEffect(() => {
    if (parts) onViewed(head);
  }, [parts, head, onViewed]);
  return (
    <LoadingRegion
      pending={result === undefined}
      label="Loading changes from GitHub…"
      feedback={
        result instanceof Error ? (
          <div role="alert">
            <p>{result.message}</p>
            <a
              className={styles.external}
              href={`${url}/files`}
              target="_blank"
              rel="noreferrer"
            >
              Open on GitHub <ArrowSquareOutIcon size={14} />
            </a>
          </div>
        ) : undefined
      }
    >
      {parts &&
        (parts.length ? (
          <div className={styles.files}>
            {parts.map((part, index) => (
              <DiffViewer
                // biome-ignore lint/suspicious/noArrayIndexKey: A file's patch can repeat; its place in this diff cannot.
                key={index}
                content={part.content}
                files={part.files}
              />
            ))}
          </div>
        ) : (
          <p>No file changes.</p>
        ))}
    </LoadingRegion>
  );
}
