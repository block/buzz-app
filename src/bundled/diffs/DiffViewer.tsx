import { Diff, Hunk, type FileData } from "react-diff-view";
import "react-diff-view/style/index.css";
import { diffType, fileLabel, labels } from "./parse";
import styles from "./Diffs.module.css";

export function DiffViewer({
  content,
  files,
  filePath,
  viewType = "unified",
}: {
  content: string;
  files: FileData[] | undefined;
  filePath?: string | undefined;
  viewType?: "unified" | "split";
}) {
  if (!files) return <pre className={styles.raw}>{content}</pre>;
  if (!files.length) return <p className="text-body-sm">No diff content</p>;
  return (
    <div className={styles.viewer}>
      {files.map((file) => {
        const label = fileLabel(file, filePath);
        const type = diffType(file);
        const changes = file.hunks.flatMap((hunk) => hunk.changes);
        const additions = changes.filter(
          (change) => change.type === "insert",
        ).length;
        const deletions = changes.filter(
          (change) => change.type === "delete",
        ).length;
        return (
          <section
            className={styles.file}
            key={`${file.oldPath}:${file.newPath}:${file.oldRevision}:${file.newRevision}`}
            aria-label={label}
          >
            {(files.length > 1 || label !== filePath || type !== "modify") && (
              <header className={styles.fileHeader}>
                <span className={styles.filename}>{label}</span>
                <span>{labels[type]}</span>
                <span className={styles.added}>+{additions}</span>
                <span className={styles.removed}>−{deletions}</span>
              </header>
            )}
            {file.hunks.length ? (
              <Diff
                className={
                  (viewType === "split" ? styles.split : styles.unified) ?? ""
                }
                diffType={type}
                hunks={file.hunks}
                viewType={viewType}
              >
                {(hunks) =>
                  hunks.map((hunk) => (
                    <Hunk
                      key={`${hunk.oldStart}:${hunk.newStart}:${hunk.content}`}
                      hunk={hunk}
                    />
                  ))
                }
              </Diff>
            ) : (
              <p className={styles.notice}>No textual hunks in this diff.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
