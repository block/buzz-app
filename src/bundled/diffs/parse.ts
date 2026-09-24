import { parseDiff, type FileData, type DiffType } from "react-diff-view";

export function parsePatch(content: string): FileData[] | undefined {
  // Legacy send-diff caps UTF-8 payloads at 60 KiB. Unbounded relay content
  // stays readable without allocating a diff table.
  if (content.length > 100_000) return undefined;
  if (!content.trim()) return [];
  try {
    const files = parseDiff(content).filter(
      (file) => file.hunks.length || file.oldPath || file.newPath,
    );
    // The parser accepts incomplete hunks. Do not present a cut-off patch as a
    // complete change; the raw fallback preserves even its final partial line.
    const complete = files.every((file) =>
      file.hunks.every((hunk) => {
        // gitdiff-parser 0.3.1 treats explicit ,0 as the omitted-count default
        // of 1. Restore header counts before validating or rendering the hunk.
        const counts = /^@@\s+-\d+(?:,(\d+))?\s+\+\d+(?:,(\d+))?\s+@@/.exec(
          hunk.content,
        );
        if (!counts) return false;
        hunk.oldLines = Number(counts[1] ?? 1);
        hunk.newLines = Number(counts[2] ?? 1);
        return (
          hunk.changes.filter((change) => change.type !== "insert").length ===
            hunk.oldLines &&
          hunk.changes.filter((change) => change.type !== "delete").length ===
            hunk.newLines
        );
      }),
    );
    return files.length && complete ? files : undefined;
  } catch {
    return undefined;
  }
}
export function fileLabel(file: FileData, fallback?: string): string {
  const oldPath = file.oldPath === "/dev/null" ? undefined : file.oldPath;
  const newPath = file.newPath === "/dev/null" ? undefined : file.newPath;
  return oldPath && newPath && oldPath !== newPath
    ? `${oldPath} → ${newPath}`
    : newPath || oldPath || fallback || "diff";
}
export function diffType(file: FileData): DiffType {
  return ["add", "copy", "delete", "rename"].includes(file.type)
    ? file.type
    : "modify";
}
export const labels: Record<DiffType, string> = {
  add: "New file",
  copy: "Copied",
  delete: "Deleted",
  modify: "Modified",
  rename: "Renamed",
};
