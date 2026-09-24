import type { Transaction } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import { scanMarkdown } from "../relay/message-content";
import {
  composerSchema as schema,
  projectComposerDocument,
  composerMarkdownContext,
} from "./composer-document";

/** Adopt only the inline code span just closed by typing, not pasted/restored
 * Markdown or fenced blocks. The parser owns escapes and backtick matching. */
export function applyComposerCodeInput(tr: Transaction): boolean {
  if (tr.selection.$from.parent.type.spec.code) return false;
  const source = projectComposerDocument(tr.doc);
  const caret = source.source(tr.selection.from);
  const markdown = composerMarkdownContext(tr.doc, source).text;
  const { tree, tooDeep } = scanMarkdown(markdown);
  if (tooDeep) return false;
  const pending = [tree];
  const unmatched: number[] = [];
  let range:
    | { start: number; end: number; innerStart: number; innerEnd: number }
    | undefined;
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (node.type === "inlineCode" && start !== undefined && end === caret) {
      const raw = source.draft.text.slice(start, end);
      if (/[\r\n]/.test(raw)) continue;
      const delimiter = /^`+/.exec(raw)?.[0].length;
      if (!delimiter) continue;
      let innerStart = start + delimiter,
        innerEnd = end - delimiter;
      const value = source.draft.text.slice(innerStart, innerEnd);
      // CommonMark removes one boundary space when both surround nonspace text.
      if (value.startsWith(" ") && value.endsWith(" ") && /[^ ]/.test(value)) {
        innerStart++;
        innerEnd--;
      }
      if (innerStart < innerEnd) range = { start, end, innerStart, innerEnd };
    }
    if (
      node.type === "text" &&
      start !== undefined &&
      end !== undefined &&
      /(^|[^\\])(?:\\\\)*`/.test(markdown.slice(start, end))
    )
      unmatched.push(start);
    // No input rules inside links, images, HTML, or fenced/indented code.
    if (
      [
        "root",
        "paragraph",
        "strong",
        "emphasis",
        "delete",
        "blockquote",
        "list",
        "listItem",
      ].includes(node.type)
    )
      pending.push(...(node.children ?? []));
  }
  if (!range) return false;
  // A shorter inner pair can look complete while a longer opener is unfinished
  // (``a`b`). Wait for that outer delimiter rather than consuming the inner pair.
  const lineStart = source.draft.text.lastIndexOf("\n", range.start - 1) + 1;
  if (unmatched.some((start) => start >= lineStart && start < range.start))
    return false;
  const from = source.position(range.start),
    to = source.position(range.end, -1);
  if (
    (["code", "link", "literal"] as const).some((name) =>
      tr.doc.rangeHasMark(from, to, schema.marks[name]),
    )
  )
    return false;
  // URLs/mentions may already be atoms. Expand them on this transaction, keeping
  // explicit recipient provenance; never normalize until the code mark exists.
  for (const token of [...source.tokens].reverse()) {
    if (token.from < from || token.to > to) continue;
    const marks = token.node.attrs.recipient
      ? [
          ...token.node.marks,
          schema.marks.recipient.create(token.node.attrs.recipient),
        ]
      : token.node.marks;
    tr.replaceWith(
      token.from,
      token.to,
      schema.text(token.node.attrs.source, marks),
    );
  }
  const expanded = projectComposerDocument(tr.doc);
  const first = expanded.position(range.start),
    last = expanded.position(range.end, -1);
  const innerStart = expanded.position(range.innerStart),
    innerEnd = expanded.position(range.innerEnd, -1);
  tr.delete(innerEnd, last).delete(first, innerStart);
  const end = first + innerEnd - innerStart;
  tr.addMark(first, end, schema.marks.code.create());
  tr.setSelection(TextSelection.create(tr.doc, end));
  // The closing delimiter exits code; subsequent prose must stay ordinary text.
  tr.setStoredMarks([]);
  return true;
}
