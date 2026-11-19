import { useEffect, useMemo, useState } from "react";
import {
  parsePatchFiles,
  preloadHighlighter,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { FileDiff as ReactFileDiff } from "@pierre/diffs/react";
import type { FileData } from "./parse";
import { languageFor } from "../file-viewer/highlight";
import styles from "./Diffs.module.css";

function RawDiff({ content }: { content: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: Preserve keyboard-scrollable literal diff fallback.
    <pre
      className={styles.raw}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The raw scrollport needs keyboard panning.
      tabIndex={0}
      role="region"
      aria-label="Raw diff"
    >
      {content}
    </pre>
  );
}

/** All three diff callers share this strict parse gate and readable fallback. */
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
  if (!files) return <RawDiff content={content} />;
  if (!files.length) return <p className="text-body-sm">No diff content</p>;
  // Pierre stores partial patches compactly: absolute line numbers do not
  // measure highlighting cost. Bound the supplied content instead.
  if (
    files.some((file) => {
      const changes = file.hunks.flatMap((hunk) => hunk.changes);
      return (
        file.isBinary ||
        !file.hunks.length ||
        changes.length > 500 ||
        changes.some((change) => change.content.length > 2_000) ||
        changes.reduce((size, change) => size + change.content.length, 0) >
          12_000
      );
    })
  )
    return <RawDiff content={content} />;
  return (
    <ParsedDiff
      content={content}
      files={files}
      filePath={filePath}
      viewType={viewType}
    />
  );
}

function ParsedDiff({
  content,
  files,
  filePath,
  viewType,
}: {
  content: string;
  files: FileData[];
  filePath?: string | undefined;
  viewType: "unified" | "split";
}) {
  const parsed = useMemo(() => {
    try {
      const entries = parsePatchFiles(content).flatMap((patch) => patch.files);
      if (
        entries.length !== files.length ||
        entries.some(
          (entry, index) =>
            entry.name !==
            (files[index]?.newPath === "/dev/null"
              ? files[index]?.oldPath
              : files[index]?.newPath),
        )
      )
        return undefined;
      return entries;
    } catch {
      return undefined;
    }
  }, [content, files]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [themeType, setThemeType] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.colorMode === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    if (!parsed) return;
    let active = true;
    setReady(false);
    setFailed(false);
    void preloadHighlighter({
      themes: ["pierre-light", "pierre-dark"],
      langs: [
        ...new Set(parsed.map((file) => languageFor(file.name) ?? "text")),
      ],
      preferredHighlighter: "shiki-js",
    }).then(
      () => {
        if (active) setReady(true);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [parsed]);
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() =>
      setThemeType(root.dataset.colorMode === "dark" ? "dark" : "light"),
    );
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-color-mode"],
    });
    return () => observer.disconnect();
  }, []);
  if (!parsed || failed || !ready) return <RawDiff content={content} />;
  return (
    <div className={styles.viewer}>
      {parsed.map((file, index) => (
        <PierreFile
          // biome-ignore lint/suspicious/noArrayIndexKey: A path may repeat across commits; its position is stable in this patch.
          key={`${file.prevName ?? ""}:${file.name}:${index}`}
          file={file}
          filePath={filePath}
          hideHeader={
            parsed.length === 1 &&
            filePath === file.name &&
            file.type === "change"
          }
          onFailure={() => setFailed(true)}
          themeType={themeType}
          viewType={viewType}
        />
      ))}
    </div>
  );
}

function PierreFile({
  file,
  filePath,
  hideHeader,
  onFailure,
  themeType,
  viewType,
}: {
  file: FileDiffMetadata;
  filePath?: string | undefined;
  hideHeader: boolean;
  onFailure: () => void;
  themeType: "light" | "dark";
  viewType: "unified" | "split";
}) {
  return (
    <section
      className={styles.file}
      aria-label={filePath || file.name}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: File-level keyboard focus precedes inner code scrollports.
      tabIndex={0}
    >
      <ReactFileDiff
        fileDiff={file}
        options={{
          theme: { light: "pierre-light", dark: "pierre-dark" },
          themeType,
          diffStyle: viewType,
          diffIndicators: "classic",
          disableFileHeader: hideHeader,
          overflow: "scroll",
          tokenizeMaxLength: 12_000,
          tokenizeMaxLineLength: 2_000,
          onPostRender: (node) => {
            if (node.shadowRoot?.querySelector("[data-error-wrapper]"))
              onFailure();
            // Split code columns own their horizontal scrollports.
            const columns = node.shadowRoot?.querySelectorAll("code") ?? [];
            for (const [index, code] of Array.from(columns).entries()) {
              code.tabIndex = 0;
              code.setAttribute("role", "region");
              code.setAttribute(
                "aria-label",
                `${file.name} ${viewType === "split" ? (index === 0 ? "old code" : "new code") : "code"}`,
              );
            }
          },
        }}
      />
    </section>
  );
}
