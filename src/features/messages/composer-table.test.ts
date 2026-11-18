import { describe, expect, it } from "vitest";
import {
  EditorState,
  Selection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import type { Node as EditorNode } from "prosemirror-model";
import {
  composerSchema as schema,
  projectComposerDocument,
  readComposerDocument,
  readComposerSnapshot,
} from "./composer-document";
import { composerMarkdown } from "./composer-markdown";
import { mentionDraft } from "./mention-draft";
import { toggleComposerBlock, composerBlockLineBreak } from "./composer-blocks";
import {
  addTableColumn,
  addTableRow,
  convertTables,
  convertTypedTable,
  deleteAcrossTables,
  deleteEmptyTable,
  deleteTable,
  deleteTableColumn,
  deleteTableRow,
  insertTable,
  paragraphTables,
  tableArrow,
  tableCursor,
  tableFromRows,
  tableNeighbour,
  tableShape,
  tableTab,
  tidyTable,
  tsvRows,
  withTables,
} from "./composer-table";

type Align = "left" | "center" | "right" | null;

const { paragraph, table, table_row: row, table_cell: cell } = schema.nodes;

const text = (value: string, ...marks: string[]) =>
  schema.text(
    value,
    marks.map((name) => schema.marks[name]?.create() as never),
  );
const para = (value = "") =>
  paragraph.create(null, value ? schema.text(value) : undefined);
const doc = (...blocks: EditorNode[]) => schema.nodes.doc.create(null, blocks);
const grid = (rows: string[][], aligns: Align[] = []) =>
  table.create(
    null,
    rows.map((cells, r) =>
      row.create(
        null,
        cells.map((value, c) =>
          cell.create(
            { header: r === 0, align: aligns[c] ?? null },
            value ? schema.text(value) : undefined,
          ),
        ),
      ),
    ),
  );
const markdown = (root: EditorNode) =>
  composerMarkdown(projectComposerDocument(root).draft);
const cellText = (node: EditorNode) =>
  Array.from({ length: node.childCount }, (_, r) =>
    Array.from(
      { length: node.child(r).childCount },
      (_, c) => node.child(r).child(c).textContent,
    ),
  );

function inCell(root: EditorNode, r: number, c: number, offset = 0) {
  let found = 0;
  root.descendants((node, pos) => {
    if (node.type === table) {
      let position = pos + 1;
      for (let i = 0; i < r; i++) position += node.child(i).nodeSize;
      position += 1;
      for (let i = 0; i < c; i++) position += node.child(r).child(i).nodeSize;
      found = position + 1 + offset;
      return false;
    }
  });
  return EditorState.create({
    doc: root,
    selection: TextSelection.create(root, found),
    plugins: [tableShape],
  });
}
const apply = (state: EditorState, tr: Transaction | undefined) => {
  if (!tr) throw new Error("command did not apply");
  return state.apply(tr);
};
const firstTable = (root: EditorNode) => {
  let found: EditorNode | undefined;
  root.descendants((node) => {
    if (node.type === table && !found) found = node;
    return !found;
  });
  if (!found) throw new Error("no table");
  return found;
};
const caret = (state: EditorState) => {
  const cursor = tableCursor(state.selection.$from);
  return cursor && [cursor.row, cursor.col, cursor.offset];
};

describe("table serialization", () => {
  it("writes a header, a delimiter row with alignment, and the body", () => {
    const root = doc(
      grid(
        [
          ["Item", "Qty", "Price"],
          ["Tea", "2", "3.50"],
        ],
        ["left", "center", "right"],
      ),
    );
    expect(markdown(root)).toBe(
      [
        "| Item | Qty | Price |",
        "| :--- | :---: | ---: |",
        "| Tea | 2 | 3.50 |",
      ].join("\n"),
    );
  });
  it("leaves unaligned columns plain and keeps empty cells", () => {
    expect(
      markdown(
        doc(
          grid([
            ["a", ""],
            ["", "d"],
          ]),
        ),
      ),
    ).toBe("| a |  |\n| --- | --- |\n|  | d |");
  });
  it("escapes a literal pipe and keeps authored escapes stable", () => {
    expect(
      markdown(
        doc(
          grid([
            ["a|b", "c"],
            ["x\\|y", "z"],
          ]),
        ),
      ),
    ).toBe("| a\\|b | c |\n| --- | --- |\n| x\\|y | z |");
  });
  it("writes inline marks inside cells", () => {
    const root = doc(
      table.create(null, [
        row.create(null, [
          cell.create({ header: true }, text("hi", "bold")),
          cell.create({ header: true }, text("code", "code")),
        ]),
      ]),
    );
    expect(markdown(root)).toBe("| **hi** | `code` |\n| --- | --- |");
  });
  it("separates a table from the paragraphs around it with blank lines", () => {
    const root = doc(para("before"), grid([["a"], ["b"]]), para("after"));
    expect(markdown(root)).toBe("before\n\n| a |\n| --- |\n| b |\n\nafter");
  });
  it("serializes a table inside a quote", () => {
    const root = doc(
      schema.nodes.blockquote.create(null, [grid([["a"], ["b"]]), para("x")]),
    );
    expect(markdown(root)).toBe("> | a |\n> | --- |\n> | b |\n>\n> x");
  });
  it("counts draft text as one line per cell", () => {
    expect(
      projectComposerDocument(
        doc(
          grid([
            ["a", "b"],
            ["c", "d"],
          ]),
        ),
      ).draft.text,
    ).toBe("a\nb\nc\nd");
  });
});

describe("table parsing", () => {
  const parse = (source: string) => {
    const result = paragraphTables(para(source));
    return result?.nodes;
  };
  it("turns pipe rows into a header and body", () => {
    const nodes = parse("| a | b |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |");
    expect(nodes).toHaveLength(1);
    const found = nodes?.[0] as EditorNode;
    expect(cellText(found)).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(found.child(0).child(0).attrs).toMatchObject({
      header: true,
      align: "left",
    });
    expect(found.child(1).child(1).attrs).toMatchObject({
      header: false,
      align: "right",
    });
  });
  it("reads rows without outer pipes", () => {
    const found = parse("a | b\n--- | ---\n1 | 2")?.[0] as EditorNode;
    expect(cellText(found)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
  it("pads short rows and drops cells past the header", () => {
    const found = parse("| a | b |\n| - | - |\n| 1 |\n| 2 | 3 | 4 |")?.[0];
    expect(cellText(found as EditorNode)).toEqual([
      ["a", "b"],
      ["1", ""],
      ["2", "3"],
    ]);
  });
  it("reads escaped pipes as text", () => {
    const found = parse("| a\\|b | c |\n| - | - |")?.[0] as EditorNode;
    expect(cellText(found)).toEqual([["a|b", "c"]]);
  });
  it("keeps prose around a table as paragraphs", () => {
    const nodes = parse("intro\n\n| a |\n| - |\n| 1 |\n\noutro");
    expect(nodes?.map((node) => node.type.name)).toEqual([
      "paragraph",
      "table",
      "paragraph",
    ]);
    expect(nodes?.[0]?.textContent).toBe("intro");
    expect(nodes?.[2]?.textContent).toBe("outro");
  });
  it("leaves text that is not a table alone", () => {
    expect(parse("a | b\njust text")).toBeUndefined();
    expect(parse("| a | b |")).toBeUndefined();
    expect(parse("```\n| a |\n| - |\n```")).toBeUndefined();
    expect(parse("> | a |\n> | - |")).toBeUndefined();
  });
  it("keeps marks and chips inside cells", () => {
    const token = schema.nodes.token.create({
      source: "https://example.com",
      editAsText: true,
    });
    const block = paragraph.create(null, [
      schema.text("| "),
      schema.text("hi", [schema.marks.bold.create()]),
      schema.text(" | "),
      token,
      schema.text(" |\n| - | - |"),
    ]);
    const found = paragraphTables(block)?.nodes[0] as EditorNode;
    const first = found.child(0).child(0);
    expect(first.firstChild?.marks.map((mark) => mark.type.name)).toEqual([
      "bold",
    ]);
    expect(found.child(0).child(1).firstChild?.type.name).toBe("token");
  });
});

describe("table round trip", () => {
  const roundTrip = (root: EditorNode) => {
    const source = markdown(root);
    const parsed = withTables(
      readComposerDocument(mentionDraft({ text: source, recipients: [] }), []),
    );
    return { source, parsed };
  };
  it("parses what the composer wrote back to the same table", () => {
    const original = grid(
      [
        ["Name", "Pipe | here", "Note"],
        ["Ada", "a\\b", ""],
        ["", "x", "y"],
      ],
      ["left", null, "right"],
    );
    const { source, parsed } = roundTrip(doc(original));
    expect(parsed.firstChild?.eq(tidyTable(original))).toBe(true);
    expect(markdown(parsed)).toBe(source);
  });
  it("is stable for marked cells", () => {
    const root = doc(
      table.create(null, [
        row.create(null, [
          cell.create({ header: true }, text("bold", "bold")),
          cell.create({ header: true }, text("gone", "strike")),
        ]),
        row.create(null, [
          cell.create({ header: false }, text("it", "italic")),
          cell.create({ header: false }, text("c", "code")),
        ]),
      ]),
    );
    const { source, parsed } = roundTrip(root);
    expect(markdown(parsed)).toBe(source);
  });
  it("keeps the table in a restored draft snapshot", () => {
    const root = doc(para("a"), grid([["h"], ["x"]], ["center"]));
    const draft = mentionDraft(
      JSON.parse(JSON.stringify(projectComposerDocument(root).draft)),
    );
    expect(readComposerSnapshot(draft.document)?.eq(root)).toBe(true);
    expect(readComposerDocument(draft, []).eq(root)).toBe(true);
    expect(composerMarkdown(draft)).toBe("a\n\n| h |\n| :---: |\n| x |");
  });
  it("rejects a snapshot with an unknown alignment", () => {
    const json = JSON.parse(
      JSON.stringify(projectComposerDocument(doc(grid([["h"]]))).draft),
    );
    json.document.content.content[0].content[0].content[0].attrs.align = "wide";
    expect(readComposerSnapshot(json.document)).toBeUndefined();
  });
});

describe("spreadsheet paste", () => {
  it("reads tab-separated rows", () => {
    expect(tsvRows("a\tb\n1\t2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
  it("reads quoted cells with tabs, quotes and line breaks", () => {
    expect(tsvRows('"a\tb"\t"say ""hi"""\n"x\ny"\tz')).toEqual([
      ["a\tb", 'say "hi"'],
      ["x\ny", "z"],
    ]);
  });
  it("needs two rows of two cells", () => {
    expect(tsvRows("a\tb")).toBeUndefined();
    expect(tsvRows("a\nb")).toBeUndefined();
    expect(tsvRows("a\tb\nc")).toBeUndefined();
    expect(tsvRows('"open\tx\ny')).toBeUndefined();
  });
  it("does not read indented code as cells", () => {
    expect(tsvRows("\tif err != nil {\n\t\treturn err\n\t}\n")).toBeUndefined();
    expect(
      tsvRows("build:\n\tgo build ./...\n\tgo test ./...\n"),
    ).toBeUndefined();
    expect(tsvRows("\tgo build\t./...\n\tgo test\t./...\n")).toBeUndefined();
  });
  it("reads cells that only some rows start with a tab", () => {
    expect(tsvRows("\tQ1\tQ2\nrev\t1\t2\n")).toEqual([
      ["", "Q1", "Q2"],
      ["rev", "1", "2"],
    ]);
  });
  it("needs a table in the copied HTML when there is any", () => {
    const sheets =
      '<meta charset=\'utf-8\'><google-sheets-html-origin><style type="text/css"></style><table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1"><colgroup><col width="100"/></colgroup><tbody><tr><td>Name</td><td>Qty</td></tr><tr><td>Tea</td><td>2</td></tr></tbody></table>';
    const excel =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><!--StartFragment--><table border=0 cellpadding=0 cellspacing=0><tr><td>Name</td><td>Qty</td></tr><tr><td>Tea</td><td>2</td></tr></table><!--EndFragment--></body></html>';
    const editor =
      '<meta charset=\'utf-8\'><div style="color: #d4d4d4;background-color: #1e1e1e;white-space: pre;"><div><span style="color: #d4d4d4;">\tfoo\tbar</span></div><div><span style="color: #d4d4d4;">\tbaz\tqux</span></div></div>';
    const tabs = "Name\tQty\nTea\t2\n";
    const expected = [
      ["Name", "Qty"],
      ["Tea", "2"],
    ];
    expect(tsvRows(tabs, sheets)).toEqual(expected);
    expect(tsvRows(tabs, excel)).toEqual(expected);
    expect(tsvRows(tabs, editor)).toBeUndefined();
    expect(tsvRows(tabs, "<p>Name\tQty</p>")).toBeUndefined();
    expect(tsvRows("\tfoo\tbar\n\tbaz\tqux\n", editor)).toBeUndefined();
    expect(tsvRows("\tfoo\tbar\n\tbaz\tqux\n", sheets)).toEqual([
      ["", "foo", "bar"],
      ["", "baz", "qux"],
    ]);
  });
  it("builds a table with a header row and flattened cells", () => {
    const built = tableFromRows([
      ["a", "b"],
      ["x\ny", "z"],
    ]);
    expect(cellText(built)).toEqual([
      ["a", "b"],
      ["x y", "z"],
    ]);
    expect(built.child(0).child(0).attrs.header).toBe(true);
    expect(markdown(doc(built))).toBe("| a | b |\n| --- | --- |\n| x y | z |");
  });
});

describe("table conversion", () => {
  it("converts only the paragraphs a change touches", () => {
    const root = doc(para("| a |\n| - |\n| 1 |"), para("| b |\n| - |\n| 2 |"));
    const state = EditorState.create({ doc: root });
    const tr = state.tr;
    expect(convertTables(tr, 1, 2)).toBe(true);
    expect(tr.doc.childCount).toBe(2);
    expect(tr.doc.child(0).type).toBe(table);
    expect(tr.doc.child(1).type).toBe(paragraph);
    expect(tr.doc.child(1).textContent).toContain("| b |");
  });
  it("converts every table when a draft loads", () => {
    const loaded = withTables(
      doc(para("| a |\n| - |\n\ntext\n\n| b |\n| - |")),
    );
    expect(loaded.children.map((node) => node.type.name)).toEqual([
      "table",
      "paragraph",
      "table",
      "paragraph",
    ]);
  });
  it("converts a header and delimiter typed above the caret", () => {
    const root = doc(para("| a | b |\n| - | - |"));
    const state = EditorState.create({
      doc: root,
      selection: Selection.atEnd(root),
    });
    const next = apply(state, convertTypedTable(state));
    expect(next.doc.child(0).type).toBe(table);
    expect(cellText(next.doc.child(0))).toEqual([["a", "b"]]);
    expect(next.doc.child(1).type).toBe(paragraph);
    expect(next.selection.$from.parent).toBe(next.doc.child(1));
  });
  it("does not convert while the table is still incomplete", () => {
    const root = doc(para("| a | b |"));
    const state = EditorState.create({
      doc: root,
      selection: Selection.atEnd(root),
    });
    expect(convertTypedTable(state)).toBeUndefined();
  });
  it("sends a line break inside a typed table as conversion", () => {
    const root = doc(para("| a |\n| - |"));
    const state = EditorState.create({
      doc: root,
      selection: Selection.atEnd(root),
    });
    const next = apply(state, composerBlockLineBreak(state));
    expect(next.doc.child(0).type).toBe(table);
  });
});

describe("table commands", () => {
  const base = () =>
    doc(
      para("above"),
      grid(
        [
          ["a", "b"],
          ["c", "d"],
        ],
        ["left", "right"],
      ),
      para("below"),
    );
  it("inserts a 3 by 2 grid with the caret in the first header cell", () => {
    const root = doc(para());
    const state = EditorState.create({ doc: root });
    const next = apply(state, insertTable(state));
    const made = firstTable(next.doc);
    expect(made.childCount).toBe(2);
    expect(made.child(0).childCount).toBe(3);
    expect(made.child(0).child(0).attrs.header).toBe(true);
    expect(made.child(1).child(0).attrs.header).toBe(false);
    expect(caret(next)).toEqual([0, 0, 0]);
    expect(next.doc.lastChild?.type).toBe(paragraph);
  });
  it("inserts below prose and splits a caret inside text", () => {
    const root = doc(para("hello"));
    const state = EditorState.create({
      doc: root,
      selection: TextSelection.create(root, 3),
    });
    const next = apply(state, insertTable(state));
    expect(next.doc.children.map((node) => node.type.name)).toEqual([
      "paragraph",
      "table",
      "paragraph",
    ]);
    expect(next.doc.child(0).textContent).toBe("he");
    expect(next.doc.child(2).textContent).toBe("llo");
  });
  it("is the Table toggle, and does nothing inside a table", () => {
    const state = EditorState.create({ doc: doc(para()) });
    const next = apply(state, toggleComposerBlock(state, "table"));
    expect(firstTable(next.doc)).toBeDefined();
    expect(toggleComposerBlock(next, "table")).toBeUndefined();
    expect(toggleComposerBlock(next, "code_block")).toBeUndefined();
    expect(toggleComposerBlock(next, "bullet_list")).toBeUndefined();
  });
  it("adds rows above and below, never above the header", () => {
    const state = inCell(base(), 1, 1);
    const below = apply(state, addTableRow(state, true));
    expect(cellText(firstTable(below.doc))).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["", ""],
    ]);
    const above = apply(state, addTableRow(state, false));
    expect(cellText(firstTable(above.doc))).toEqual([
      ["a", "b"],
      ["", ""],
      ["c", "d"],
    ]);
    expect(caret(above)).toEqual([1, 1, 0]);
    expect(addTableRow(inCell(base(), 0, 0), false)).toBeUndefined();
  });
  it("adds columns left and right with header cells in the first row", () => {
    const state = inCell(base(), 0, 0);
    const right = apply(state, addTableColumn(state, true));
    expect(cellText(firstTable(right.doc))).toEqual([
      ["a", "", "b"],
      ["c", "", "d"],
    ]);
    expect(firstTable(right.doc).child(0).child(1).attrs.header).toBe(true);
    expect(caret(right)).toEqual([0, 1, 0]);
    const left = apply(state, addTableColumn(state, false));
    expect(cellText(firstTable(left.doc))).toEqual([
      ["", "a", "b"],
      ["", "c", "d"],
    ]);
    expect(caret(left)).toEqual([0, 0, 0]);
  });
  it("deletes the caret's row and column", () => {
    const state = inCell(base(), 1, 0);
    const row = apply(state, deleteTableRow(state));
    expect(cellText(firstTable(row.doc))).toEqual([["a", "b"]]);
    const col = apply(state, deleteTableColumn(state));
    expect(cellText(firstTable(col.doc))).toEqual([["b"], ["d"]]);
    expect(caret(col)).toEqual([1, 0, 0]);
  });
  it("deletes the table with its last row or column, and on request", () => {
    const single = doc(para("x"), grid([["a"]]));
    const state = inCell(single, 0, 0);
    const gone = apply(state, deleteTableRow(state));
    expect(gone.doc.childCount).toBe(1);
    const column = apply(state, deleteTableColumn(state));
    expect(column.doc.childCount).toBe(1);
    const whole = inCell(base(), 1, 1);
    const removed = apply(whole, deleteTable(whole));
    expect(removed.doc.children.map((node) => node.textContent)).toEqual([
      "above",
      "below",
    ]);
  });
  it("leaves a paragraph when the only block is deleted", () => {
    const state = inCell(doc(grid([["a"]])), 0, 0);
    const next = apply(state, deleteTable(state));
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.child(0).type).toBe(paragraph);
  });
  it("moves with Tab and Shift+Tab, adding a row after the last cell", () => {
    let state = inCell(base(), 0, 0, 1);
    state = apply(state, tableTab(state, false));
    expect(caret(state)).toEqual([0, 1, 0]);
    state = apply(state, tableTab(state, false));
    expect(caret(state)).toEqual([1, 0, 0]);
    state = apply(state, tableTab(state, true));
    expect(caret(state)).toEqual([0, 1, 1]);
    state = inCell(base(), 1, 1);
    state = apply(state, tableTab(state, false));
    expect(firstTable(state.doc).childCount).toBe(3);
    expect(caret(state)).toEqual([2, 0, 0]);
    expect(tableTab(inCell(base(), 0, 0), true)).toBeUndefined();
  });
  it("moves between cells with arrows and leaves the table at its edges", () => {
    let state = inCell(base(), 0, 0);
    state = apply(state, tableArrow(state, "right"));
    expect(caret(state)).toEqual([0, 1, 0]);
    state = apply(state, tableArrow(state, "down"));
    expect(caret(state)).toEqual([1, 1, 0]);
    state = apply(state, tableArrow(state, "left"));
    expect(caret(state)).toEqual([1, 0, 1]);
    state = apply(state, tableArrow(state, "up"));
    expect(caret(state)).toEqual([0, 0, 1]);
    const up = apply(state, tableArrow(state, "up"));
    expect(up.selection.$from.parent.textContent).toBe("above");
    expect(up.selection.$from.parentOffset).toBe(5);
    const end = inCell(base(), 1, 1);
    const down = apply(end, tableArrow(end, "down"));
    expect(down.selection.$from.parent.textContent).toBe("below");
    const right = apply(end, tableArrow(end, "right"));
    expect(right.selection.$from.parent.textContent).toBe("below");
  });
  it("adds a paragraph to leave a table that opens or ends the draft", () => {
    const only = doc(grid([["a"]]));
    const start = inCell(only, 0, 0);
    const above = apply(start, tableArrow(start, "up"));
    expect(above.doc.child(0).type).toBe(paragraph);
    expect(above.selection.$from.parent).toBe(above.doc.child(0));
    const below = apply(start, tableArrow(start, "down"));
    expect(below.doc.lastChild?.type).toBe(paragraph);
    expect(below.selection.$from.parent).toBe(below.doc.lastChild);
  });
  it("removes an empty table with Backspace and keeps one with text", () => {
    const empty = inCell(
      doc(
        para("x"),
        grid([
          ["", ""],
          ["", ""],
        ]),
      ),
      1,
      1,
    );
    const next = apply(empty, deleteEmptyTable(empty));
    expect(next.doc.children.map((node) => node.type.name)).toEqual([
      "paragraph",
    ]);
    expect(deleteEmptyTable(inCell(base(), 0, 0))).toBeUndefined();
  });
  it("steps into a neighbouring table from the paragraph beside it", () => {
    const root = doc(
      grid([
        ["a", "b"],
        ["c", "d"],
      ]),
      para("tail"),
    );
    const start = root.content.size - para("tail").nodeSize + 1;
    const state = EditorState.create({
      doc: root,
      selection: TextSelection.create(root, start),
    });
    expect(state.selection.$from.parent.textContent).toBe("tail");
    const next = apply(state, tableNeighbour(state, true));
    expect(caret(next)).toEqual([1, 1, 1]);
    const blank = doc(grid([["a"], ["b"]]), para());
    const empty = EditorState.create({
      doc: blank,
      selection: Selection.atEnd(blank),
    });
    const removed = apply(empty, tableNeighbour(empty, true));
    expect(removed.doc.childCount).toBe(1);
    expect(caret(removed)).toEqual([1, 0, 1]);
  });
  it("clears text across cells without breaking the grid", () => {
    const root = doc(
      grid([
        ["abc", "def"],
        ["ghi", "jkl"],
      ]),
    );
    const state = inCell(root, 0, 0, 1);
    const tr = state.tr;
    const to = (() => {
      let position = 0;
      tr.doc.descendants((node, pos) => {
        if (node.isText && node.text === "ghi") position = pos + 2;
      });
      return position;
    })();
    const from = state.selection.from;
    const at = deleteAcrossTables(tr, from, to);
    expect(at).toBe(from);
    expect(cellText(firstTable(tr.doc))).toEqual([
      ["a", ""],
      ["i", "jkl"],
    ]);
  });
  it("deletes a whole table the selection covers", () => {
    const root = doc(para("a"), grid([["x"], ["y"]]), para("b"));
    const state = EditorState.create({ doc: root });
    const tr = state.tr;
    expect(deleteAcrossTables(tr, 0, root.content.size)).toBeUndefined();
  });
  it("heals a table whose rows became uneven", () => {
    const uneven = doc(
      table.create(null, [
        row.create(null, [
          cell.create({ header: true, align: "left" }, schema.text("a")),
          cell.create({ header: true }, schema.text("b")),
        ]),
        row.create(null, [cell.create({ header: true }, schema.text("c"))]),
      ]),
    );
    const state = EditorState.create({ doc: uneven, plugins: [tableShape] });
    const next = state.apply(state.tr.insertText("!", 4));
    const healed = firstTable(next.doc);
    expect(cellText(healed)).toEqual([
      ["a!", "b"],
      ["c", ""],
    ]);
    expect(healed.child(1).child(0).attrs).toMatchObject({
      header: false,
      align: "left",
    });
  });
});
