import type { Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import {
  Fragment,
  type Node as EditorNode,
  type ResolvedPos,
} from "prosemirror-model";
import {
  EditorState,
  Plugin,
  Selection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { composerSchema as schema } from "./composer-document";

const { paragraph, table, table_row: row, table_cell: cell } = schema.nodes;

type Align = "left" | "center" | "right" | null;
type Cursor = {
  table: EditorNode;
  start: number;
  row: number;
  col: number;
  offset: number;
};

export type TableDirection = "left" | "right" | "up" | "down";

export const newTableColumns = 3;
export const newTableRows = 2;

export function tableCursor($pos: ResolvedPos): Cursor | undefined {
  for (let depth = $pos.depth; depth >= 2; depth--) {
    if ($pos.node(depth).type !== cell) continue;
    return {
      table: $pos.node(depth - 2),
      start: $pos.before(depth - 2),
      row: $pos.index(depth - 2),
      col: $pos.index(depth - 1),
      offset: $pos.parentOffset,
    };
  }
}

export function tableSize(node: EditorNode) {
  return { rows: node.childCount, cols: node.firstChild?.childCount ?? 0 };
}

function cellStart(node: EditorNode, start: number, r: number, c: number) {
  let position = start + 1;
  for (let i = 0; i < r; i++) position += node.child(i).nodeSize;
  position += 1;
  const owner = node.child(r);
  for (let i = 0; i < c; i++) position += owner.child(i).nodeSize;
  return position;
}

function inCell(
  tr: Transaction,
  start: number,
  r: number,
  c: number,
  offset: number | "end" = 0,
) {
  const node = tr.doc.nodeAt(start);
  if (node?.type !== table) return tr;
  const { rows, cols } = tableSize(node);
  const rowIndex = Math.max(0, Math.min(r, rows - 1));
  const colIndex = Math.max(0, Math.min(c, cols - 1));
  const at = cellStart(node, start, rowIndex, colIndex);
  const size = node.child(rowIndex).child(colIndex).content.size;
  return tr.setSelection(
    TextSelection.create(
      tr.doc,
      at + 1 + (offset === "end" ? size : Math.min(offset, size)),
    ),
  );
}

const emptyCell = (header: boolean, align: Align = null) =>
  cell.create({ header, align });

export function emptyTable(cols = newTableColumns, rows = newTableRows) {
  return table.create(
    null,
    Array.from({ length: rows }, (_, r) =>
      row.create(
        null,
        Array.from({ length: cols }, () => emptyCell(r === 0)),
      ),
    ),
  );
}

export function tableIsEmpty(node: EditorNode) {
  let empty = true;
  node.descendants((child) => {
    if (child.type === cell && child.content.size) empty = false;
  });
  return empty;
}

export function tidyTable(node: EditorNode): EditorNode {
  const head = node.firstChild;
  if (!head) return node;
  let cols = 0;
  node.forEach((item) => {
    cols = Math.max(cols, item.childCount);
  });
  const rows: EditorNode[] = [];
  node.forEach((item, _offset, r) => {
    const cells: EditorNode[] = [];
    for (let c = 0; c < cols; c++) {
      const existing = item.maybeChild(c);
      const align: Align = head.maybeChild(c)?.attrs.align ?? null;
      if (!existing) cells.push(emptyCell(r === 0, align));
      else if (
        existing.attrs.header === (r === 0) &&
        existing.attrs.align === align
      )
        cells.push(existing);
      else
        cells.push(
          cell.create(
            { header: r === 0, align },
            existing.content,
            existing.marks,
          ),
        );
    }
    rows.push(row.create(item.attrs, cells));
  });
  const next = table.create(node.attrs, rows);
  return next.eq(node) ? node : next;
}

export const tableShape = new Plugin({
  props: {
    decorations(state) {
      const cursor = tableCursor(state.selection.$head);
      if (!cursor) return null;
      const from = cellStart(
        cursor.table,
        cursor.start,
        cursor.row,
        cursor.col,
      );
      const owner = cursor.table.child(cursor.row).child(cursor.col);
      return DecorationSet.create(state.doc, [
        Decoration.node(from, from + owner.nodeSize, { "data-active": "" }),
      ]);
    },
  },
  appendTransaction(transactions, _old, state) {
    if (!transactions.some((tr) => tr.docChanged)) return;
    const fixes: { pos: number; node: EditorNode; tidy: EditorNode }[] = [];
    state.doc.descendants((node, pos) => {
      if (node.type !== table) return;
      const tidy = tidyTable(node);
      if (tidy !== node) fixes.push({ pos, node, tidy });
      return false;
    });
    if (!fixes.length) return;
    const cursor = state.selection.empty
      ? tableCursor(state.selection.$from)
      : undefined;
    const tr = state.tr;
    for (const { pos, node, tidy } of fixes.reverse())
      tr.replaceWith(pos, pos + node.nodeSize, tidy);
    if (cursor)
      inCell(
        tr,
        tr.mapping.map(cursor.start, -1),
        cursor.row,
        cursor.col,
        cursor.offset,
      );
    return tr;
  },
});

function exitAbove(tr: Transaction, start: number) {
  const $start = tr.doc.resolve(start);
  const found = $start.nodeBefore ? Selection.findFrom($start, -1, true) : null;
  if (found) return tr.setSelection(found);
  tr.insert(start, paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, start + 1));
}

function exitBelow(tr: Transaction, start: number, size: number) {
  const end = start + size;
  const $end = tr.doc.resolve(end);
  const found = $end.nodeAfter ? Selection.findFrom($end, 1, true) : null;
  if (found) return tr.setSelection(found);
  tr.insert(end, paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, end + 1));
}

export function addTableRow(
  state: EditorState,
  below: boolean,
): Transaction | undefined {
  const cursor = tableCursor(state.selection.$from);
  if (!cursor || (!below && cursor.row === 0)) return;
  const { table: node, start, row: r, col } = cursor;
  const head = node.child(0);
  const index = below ? r + 1 : r;
  let at = start + 1;
  for (let i = 0; i < index; i++) at += node.child(i).nodeSize;
  const tr = state.tr.insert(
    at,
    row.create(
      null,
      Array.from({ length: head.childCount }, (_, c) =>
        emptyCell(false, head.child(c).attrs.align),
      ),
    ),
  );
  return inCell(tr, start, index, col);
}

export function addTableColumn(
  state: EditorState,
  right: boolean,
): Transaction | undefined {
  const cursor = tableCursor(state.selection.$from);
  if (!cursor) return;
  const { table: node, start, row: r, col } = cursor;
  const index = right ? col + 1 : col;
  const positions: number[] = [];
  let rowStart = start + 1;
  node.forEach((item) => {
    let at = rowStart + 1;
    for (let c = 0; c < index; c++) at += item.child(c).nodeSize;
    positions.push(at);
    rowStart += item.nodeSize;
  });
  const tr = state.tr;
  for (let i = positions.length - 1; i >= 0; i--)
    tr.insert(positions[i] ?? 0, emptyCell(i === 0));
  return inCell(tr, start, r, index);
}

export function deleteTable(state: EditorState): Transaction | undefined {
  const cursor = tableCursor(state.selection.$from);
  if (!cursor) return;
  const { table: node, start } = cursor;
  const tr = state.tr.delete(start, start + node.nodeSize);
  const $at = tr.doc.resolve(Math.min(start, tr.doc.content.size));
  return tr.setSelection(Selection.near($at, -1));
}

export function deleteTableRow(state: EditorState): Transaction | undefined {
  const cursor = tableCursor(state.selection.$from);
  if (!cursor) return;
  const { table: node, start, row: r, col } = cursor;
  if (node.childCount === 1) return deleteTable(state);
  let at = start + 1;
  for (let i = 0; i < r; i++) at += node.child(i).nodeSize;
  const tr = state.tr.delete(at, at + node.child(r).nodeSize);
  return inCell(tr, start, Math.min(r, node.childCount - 2), col);
}

export function deleteTableColumn(state: EditorState): Transaction | undefined {
  const cursor = tableCursor(state.selection.$from);
  if (!cursor) return;
  const { table: node, start, row: r, col } = cursor;
  const { cols } = tableSize(node);
  if (cols === 1) return deleteTable(state);
  const ranges: [number, number][] = [];
  let rowStart = start + 1;
  node.forEach((item) => {
    let at = rowStart + 1;
    for (let c = 0; c < col; c++) at += item.child(c).nodeSize;
    ranges.push([at, at + item.child(col).nodeSize]);
    rowStart += item.nodeSize;
  });
  const tr = state.tr;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [from, to] = ranges[i] ?? [0, 0];
    tr.delete(from, to);
  }
  return inCell(tr, start, r, Math.min(col, cols - 2));
}

export function deleteEmptyTable(state: EditorState): Transaction | undefined {
  const { $from, empty } = state.selection;
  const cursor = tableCursor($from);
  if (!empty || !cursor || !tableIsEmpty(cursor.table)) return;
  return deleteTable(state);
}

export function tableTab(
  state: EditorState,
  backward: boolean,
): Transaction | undefined {
  const cursor = tableCursor(state.selection.$from);
  if (!cursor) return;
  const { table: node, start, row: r, col } = cursor;
  const { rows, cols } = tableSize(node);
  const step = col + (backward ? -1 : 1);
  const nextRow = step < 0 ? r - 1 : step >= cols ? r + 1 : r;
  const nextCol = (step + cols) % cols;
  if (nextRow < 0) return;
  if (nextRow >= rows) {
    const added = addTableRow(state, true);
    return added && inCell(added, start, rows, 0);
  }
  return inCell(state.tr, start, nextRow, nextCol, backward ? "end" : 0);
}

export function tableLineBreak(state: EditorState): Transaction | undefined {
  const cursor = tableCursor(state.selection.$from);
  if (!cursor) return;
  const { table: node, start, row: r, col } = cursor;
  if (r + 1 < node.childCount) return inCell(state.tr, start, r + 1, col);
  const added = addTableRow(state, true);
  return added && inCell(added, start, r + 1, col);
}

export function tableArrow(
  state: EditorState,
  direction: TableDirection,
): Transaction | undefined {
  const { empty } = state.selection;
  const cursor = tableCursor(state.selection.$from);
  if (!cursor || !empty) return;
  const { table: node, start, row: r, col, offset } = cursor;
  const { rows, cols } = tableSize(node);
  const tr = state.tr;
  if (direction === "left") {
    if (col > 0) return inCell(tr, start, r, col - 1, "end");
    if (r > 0) return inCell(tr, start, r - 1, cols - 1, "end");
    return exitAbove(tr, start);
  }
  if (direction === "right") {
    if (col < cols - 1) return inCell(tr, start, r, col + 1);
    if (r < rows - 1) return inCell(tr, start, r + 1, 0);
    return exitBelow(tr, start, node.nodeSize);
  }
  if (direction === "up")
    return r > 0 ? inCell(tr, start, r - 1, col, offset) : exitAbove(tr, start);
  return r < rows - 1
    ? inCell(tr, start, r + 1, col, offset)
    : exitBelow(tr, start, node.nodeSize);
}

export function atCellEdge(state: EditorState, direction: "left" | "right") {
  const { $from, empty } = state.selection;
  if (!empty || !tableCursor($from)) return false;
  return direction === "left"
    ? $from.parentOffset === 0
    : $from.parentOffset === $from.parent.content.size;
}

export function tableNeighbour(
  state: EditorState,
  backward: boolean,
): Transaction | undefined {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== paragraph) return;
  if (
    backward
      ? $from.parentOffset > 0
      : $from.parentOffset < $from.parent.content.size
  )
    return;
  const container = $from.node(-1);
  const index = $from.index(-1);
  const sibling = container.maybeChild(backward ? index - 1 : index + 1);
  if (sibling?.type !== table) return;
  const { rows, cols } = tableSize(sibling);
  if (backward) {
    const tableStart = $from.before() - sibling.nodeSize;
    const tr = state.tr;
    if ($from.parent.content.size === 0)
      tr.delete($from.before(), $from.after());
    return inCell(tr, tableStart, rows - 1, cols - 1, "end");
  }
  return inCell(state.tr, $from.after(), 0, 0);
}

export function deleteAcrossTables(
  tr: Transaction,
  from: number,
  to: number,
): number | undefined {
  const partial: { pos: number; node: EditorNode }[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type !== table) return;
    if (!(from <= pos && to >= pos + node.nodeSize))
      partial.push({ pos, node });
    return false;
  });
  if (!partial.length) return;
  const ranges: [number, number][] = [];
  for (const { pos, node } of partial) {
    node.forEach((item, rowOffset) => {
      item.forEach((owner, cellOffset) => {
        const begin = pos + 1 + rowOffset + 1 + cellOffset + 1;
        const end = begin + owner.content.size;
        const a = Math.max(begin, from);
        const b = Math.min(end, to);
        if (a < b) ranges.push([a, b]);
      });
    });
  }
  const first = partial[0];
  const last = partial[partial.length - 1];
  const lower =
    first && from > first.pos ? first.pos + first.node.nodeSize : from;
  const upper = last && to < last.pos + last.node.nodeSize ? last.pos : to;
  const base = tr.mapping.maps.length;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [a, b] = ranges[i] ?? [0, 0];
    tr.delete(a, b);
  }
  const mapping = tr.mapping.slice(base);
  const mappedLower = mapping.map(lower, -1);
  const mappedUpper = mapping.map(upper, 1);
  if (mappedLower < mappedUpper) tr.delete(mappedLower, mappedUpper);
  return mapping.map(from, -1);
}

export function deleteSelectedCells(tr: Transaction) {
  const { from, to, empty } = tr.selection;
  if (empty) return false;
  const position = deleteAcrossTables(tr, from, to);
  if (position === undefined) return false;
  tr.setSelection(Selection.near(tr.doc.resolve(position), -1));
  return true;
}

export function leaveTable(tr: Transaction) {
  const cursor = tableCursor(tr.selection.$from);
  if (!cursor) return;
  const end = cursor.start + cursor.table.nodeSize;
  if (tr.doc.resolve(end).nodeAfter) return;
  tr.insert(end, paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, end + 1));
}

export function tidyTables(content: Fragment): Fragment {
  const nodes: EditorNode[] = [];
  content.forEach((node) => {
    if (node.type === table) nodes.push(tidyTable(node));
    else if (node.isLeaf || node.isTextblock) nodes.push(node);
    else nodes.push(node.copy(tidyTables(node.content)));
  });
  return Fragment.fromArray(nodes);
}

export function placeTable(
  tr: Transaction,
  node: EditorNode,
): number | undefined {
  const { $from } = tr.selection;
  if ($from.parent.type !== paragraph) return;
  const container = $from.node(-1);
  const index = $from.index(-1);
  const blank =
    !$from.parent.content.size &&
    !(container.type === schema.nodes.list_item && index === 0);
  let at = $from.before();
  if (blank) {
    if (!container.canReplaceWith(index, index + 1, table)) return;
    tr.replaceWith(at, $from.after(), node);
  } else {
    if (!container.canReplaceWith(index + 1, index + 1, table)) return;
    if ($from.parentOffset < $from.parent.content.size) {
      tr.split($from.pos);
      at = tr.doc.resolve($from.pos).after();
    } else at = $from.after();
    tr.insert(at, node);
  }
  const end = at + node.nodeSize;
  if (!tr.doc.resolve(end).nodeAfter) tr.insert(end, paragraph.create());
  return at;
}

export function insertTable(state: EditorState): Transaction | undefined {
  if (state.selection.$from.parent.type !== paragraph) return;
  const tr = state.tr;
  tr.setSelection(TextSelection.create(tr.doc, state.selection.from));
  const start = placeTable(tr, emptyTable());
  return start === undefined ? undefined : inCell(tr, start, 0, 0);
}

export function pasteGrid(
  state: EditorState,
  node: EditorNode,
): Transaction | undefined {
  const tr = state.tr;
  if (!tr.selection.empty && !deleteSelectedCells(tr)) tr.deleteSelection();
  const start = placeTable(tr, node);
  if (start === undefined) return;
  return tr.setSelection(
    Selection.near(tr.doc.resolve(start + node.nodeSize), 1),
  );
}

const parsers = {
  extensions: [gfmTable()],
  mdastExtensions: [gfmTableFromMarkdown()],
};

function inlineLength(node: EditorNode) {
  return node.isText
    ? node.textContent.length
    : node.type.name === "hard_break"
      ? 1
      : (node.attrs.source as string).length;
}

function masked(block: EditorNode) {
  let text = "";
  block.forEach((node) => {
    text += node.isText
      ? node.textContent
      : node.type.name === "hard_break"
        ? "\n"
        : "x".repeat(inlineLength(node));
  });
  return text;
}

function slice(block: EditorNode, from: number, to: number) {
  const nodes: EditorNode[] = [];
  let at = 0;
  block.forEach((node) => {
    const length = inlineLength(node);
    const start = Math.max(from, at);
    const end = Math.min(to, at + length);
    if (start < end) {
      if (node.isText) nodes.push(node.cut(start - at, end - at));
      else if (start === at && end === at + length) nodes.push(node);
    }
    at += length;
  });
  return Fragment.fromArray(nodes);
}

function unescaped(content: Fragment) {
  const nodes: EditorNode[] = [];
  content.forEach((node) => {
    if (!node.isText) {
      nodes.push(node);
      return;
    }
    const value = node.textContent.replace(/\\([\\|])/g, (all, char: string) =>
      char === "|" ? char : all,
    );
    if (value) nodes.push(schema.text(value, node.marks));
  });
  return Fragment.fromArray(nodes);
}

function cellRange(source: string, start: number, end: number) {
  let from = start;
  let to = end;
  if (source[from] === "|") from++;
  if (to > from && source[to - 1] === "|") {
    let slashes = 0;
    while (source[to - 2 - slashes] === "\\") slashes++;
    if (slashes % 2 === 0) to--;
  }
  while (from < to && /\s/.test(source[from] ?? "")) from++;
  while (to > from && /\s/.test(source[to - 1] ?? "")) to--;
  return { from, to };
}

function tableFrom(block: EditorNode, source: string, parsed: Table) {
  const align = parsed.align ?? [];
  const cols = parsed.children[0]?.children.length ?? 0;
  return table.create(
    null,
    parsed.children.map((item, r) =>
      row.create(
        null,
        Array.from({ length: cols }, (_, c) => {
          const found = item.children[c];
          const begin = found?.position?.start.offset;
          const end = found?.position?.end.offset;
          const range =
            begin === undefined || end === undefined
              ? undefined
              : cellRange(source, begin, end);
          return cell.create(
            { header: r === 0, align: align[c] ?? null },
            range ? unescaped(slice(block, range.from, range.to)) : undefined,
          );
        }),
      ),
    ),
  );
}

export type ParagraphTables = {
  nodes: EditorNode[];
  ranges: { from: number; to: number }[];
};

export function paragraphTables(
  block: EditorNode,
): ParagraphTables | undefined {
  if (block.type !== paragraph) return;
  const source = masked(block);
  if (!source.includes("|") || !source.includes("\n")) return;
  const found = fromMarkdown(source, parsers).children.filter(
    (node): node is Table =>
      node.type === "table" &&
      node.position?.start.offset !== undefined &&
      node.position.end.offset !== undefined,
  );
  if (!found.length) return;
  const nodes: EditorNode[] = [];
  const ranges: { from: number; to: number }[] = [];
  const prose = (begin: number, finish: number) => {
    let from = begin;
    let to = finish;
    while (from < to && source[from] === "\n") from++;
    while (to > from && source[to - 1] === "\n") to--;
    const content = slice(block, from, to);
    if (!content.size) return;
    nodes.push(paragraph.create(null, content));
    ranges.push({ from, to: finish });
  };
  let from = 0;
  for (const parsed of found) {
    const start = parsed.position?.start.offset ?? 0;
    const end = parsed.position?.end.offset ?? 0;
    prose(from, Math.max(from, start - 1));
    nodes.push(tableFrom(block, source, parsed));
    ranges.push({ from: start, to: end });
    from = end + 1;
  }
  prose(from, source.length);
  return { nodes, ranges };
}

function sourceIndex(block: EditorNode, offset: number) {
  let index = 0;
  let at = 0;
  block.forEach((node) => {
    if (at >= offset) return;
    if (at + node.nodeSize <= offset) index += inlineLength(node);
    else index += offset - at;
    at += node.nodeSize;
  });
  return index;
}

function caretAfterConversion(
  tr: Transaction,
  block: EditorNode,
  result: ParagraphTables,
  nodes: EditorNode[],
  start: number,
  index: number,
) {
  let position = start;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const range = result.ranges[i];
    if (!node) break;
    if (index <= (range?.to ?? Number.POSITIVE_INFINITY)) {
      if (node.type === paragraph && range)
        return TextSelection.create(
          tr.doc,
          position +
            1 +
            slice(block, range.from, Math.max(range.from, index)).size,
        );
      return Selection.near(tr.doc.resolve(position + node.nodeSize), 1);
    }
    position += node.nodeSize;
  }
  return Selection.near(tr.doc.resolve(position), -1);
}

export function convertTables(tr: Transaction, from: number, to: number) {
  const found: { pos: number; node: EditorNode }[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === paragraph) found.push({ pos, node });
    return !node.isTextblock && node.type !== table;
  });
  let converted = false;
  for (const { pos, node } of found.reverse()) {
    const result = paragraphTables(node);
    if (!result) continue;
    const $pos = tr.doc.resolve(pos);
    const container = $pos.parent;
    const index = $pos.index();
    const nodes = [...result.nodes];
    if (
      nodes[nodes.length - 1]?.type === table &&
      index + 1 === container.childCount
    )
      nodes.push(paragraph.create());
    if (!container.canReplace(index, index + 1, Fragment.from(nodes))) continue;
    const selection = tr.selection;
    const inside =
      selection.empty &&
      selection.from > pos &&
      selection.from < pos + node.nodeSize;
    const caret = inside
      ? sourceIndex(node, selection.$from.parentOffset)
      : undefined;
    tr.replaceWith(pos, pos + node.nodeSize, nodes);
    if (caret !== undefined)
      tr.setSelection(
        caretAfterConversion(tr, node, result, nodes, pos, caret),
      );
    converted = true;
  }
  return converted;
}

export function withTables(doc: EditorNode): EditorNode {
  if (!doc.textContent.includes("|")) return doc;
  const tr = EditorState.create({ doc }).tr;
  return convertTables(tr, 0, doc.content.size) ? tr.doc : doc;
}

export function convertTypedTable(state: EditorState): Transaction | undefined {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== paragraph) return;
  const block = $from.parent;
  if (!block.textContent.includes("|")) return;
  const result = paragraphTables(block.cut(0, $from.parentOffset));
  const last = result?.nodes[result.nodes.length - 1];
  if (!result || last?.type !== table) return;
  const container = $from.node(-1);
  const index = $from.index(-1);
  const after = paragraph.create(null, block.content.cut($from.parentOffset));
  const nodes = [...result.nodes, after];
  if (!container.canReplace(index, index + 1, Fragment.from(nodes))) return;
  const tr = state.tr.replaceWith($from.before(), $from.after(), nodes);
  let position = $from.before();
  for (const node of result.nodes) position += node.nodeSize;
  return tr.setSelection(TextSelection.create(tr.doc, position + 1));
}

export function tsvRows(text: string, html = ""): string[][] | undefined {
  const input = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  if (!input.includes("\t") || !input.includes("\n")) return;
  const rows: string[][] = [[]];
  let field = "";
  let quoted = false;
  let fresh = true;
  const end = () => {
    rows[rows.length - 1]?.push(field);
    field = "";
    fresh = true;
  };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (input[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (char === '"' && fresh) {
      quoted = true;
      fresh = false;
    } else if (char === "\t") end();
    else if (char === "\n") {
      end();
      rows.push([]);
    } else {
      field += char;
      fresh = false;
    }
  }
  if (quoted) return;
  end();
  if (rows.length < 2 || rows.some((item) => item.length < 2)) return;
  if (html ? !/<table[\s>]/i.test(html) : rows.every((item) => !item[0]))
    return;
  return rows;
}

export function tableFromRows(rows: readonly (readonly string[])[]) {
  const cols = Math.max(...rows.map((item) => item.length));
  return table.create(
    null,
    rows.map((item, r) =>
      row.create(
        null,
        Array.from({ length: cols }, (_, c) => {
          const value = (item[c] ?? "").replace(/\s+/g, " ").trim();
          return cell.create(
            { header: r === 0 },
            value ? schema.text(value) : undefined,
          );
        }),
      ),
    ),
  );
}

export function tableBelow(
  state: EditorState,
  text: string,
): Transaction | undefined {
  const cursor = tableCursor(state.selection.$from);
  if (!cursor) return;
  if (!paragraphTables(paragraph.create(null, schema.text(text)))) return;
  const end = cursor.start + cursor.table.nodeSize;
  const tr = state.tr.insert(end, paragraph.create());
  return tr
    .setSelection(TextSelection.create(tr.doc, end + 1))
    .setMeta("addToHistory", false);
}
