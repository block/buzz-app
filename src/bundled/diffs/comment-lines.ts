import type { FileData } from "./parse";
export type DiffLine = { side: "deletions" | "additions"; lineNumber: number };
/** Retains both coordinates for layout-specific comment placement. */
export function commentLines(file: FileData): DiffLine[][] {
  return file.hunks.flatMap((hunk) =>
    hunk.changes.map((change): DiffLine[] =>
      change.type === "normal"
        ? [
            { side: "deletions", lineNumber: change.oldLineNumber },
            { side: "additions", lineNumber: change.newLineNumber },
          ]
        : [
            {
              side: change.type === "delete" ? "deletions" : "additions",
              lineNumber: change.lineNumber,
            },
          ],
    ),
  );
}

export function commentLineForView(
  row: readonly DiffLine[],
  side: DiffLine["side"],
  layout: "unified" | "split",
): DiffLine | undefined {
  if (layout === "unified") {
    const addition = row.find((line) => line.side === "additions");
    if (addition) return addition;
  }
  return row.find((line) => line.side === side);
}

export function commentableLine(file: FileData, line: DiffLine): boolean {
  return (
    !file.isBinary &&
    commentLines(file).some((row) =>
      row.some(
        (entry) =>
          entry.side === line.side && entry.lineNumber === line.lineNumber,
      ),
    )
  );
}
