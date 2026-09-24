import { describe, expect, it } from "vitest";
import {
  composerSchema as schema,
  projectComposerDocument,
  readComposerDocument,
  readComposerSnapshot,
} from "./composer-document";
import { composerMarkdown } from "./composer-markdown";
import { mentionDraft } from "./mention-draft";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { EditorState, TextSelection } from "prosemirror-state";
import { toggleMark } from "prosemirror-commands";
import { history, undo, redo, closeHistory } from "prosemirror-history";
import type { RootContent } from "mdast";
import type { InlineFormat } from "./composer-dom";

const paragraph = (...children: ReturnType<typeof schema.text>[]) =>
  schema.nodes.paragraph.create(null, children);
const bold = (text: string) => schema.text(text, [schema.marks.bold.create()]);
const doc = (...blocks: ReturnType<typeof paragraph>[]) =>
  schema.nodes.doc.create(null, blocks);
const serialize = (...children: ReturnType<typeof schema.text>[]) =>
  composerMarkdown(projectComposerDocument(doc(paragraph(...children))).draft);

describe("composer document boundary", () => {
  it("preserves distinct block and hard-break structures through persisted drafts", () => {
    const blocks = doc(paragraph(bold("a")), paragraph(schema.text("b")));
    const inline = doc(
      paragraph(bold("a"), schema.nodes.hard_break.create(), schema.text("b")),
    );
    expect(projectComposerDocument(blocks).draft.text).toBe("a\nb");
    expect(projectComposerDocument(inline).draft.text).toBe("a\nb");
    for (const original of [blocks, inline]) {
      const draft = mentionDraft(
        JSON.parse(JSON.stringify(projectComposerDocument(original).draft)),
      );
      expect(readComposerDocument(draft, []).eq(original)).toBe(true);
      expect(composerMarkdown(draft)).toBe("**a**\nb");
    }
  });
  it("uses document text as authoritative and rejects malformed snapshots", () => {
    const original = doc(paragraph(bold("saved")));
    expect(
      mentionDraft({
        ...projectComposerDocument(original).draft,
        text: "stale",
      }).text,
    ).toBe("saved");
    for (const content of [
      { type: "unknown" },
      { type: "doc", content: [{ type: "text", text: "bad block" }] },
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "token", attrs: { source: 5 } }],
          },
        ],
      },
    ]) {
      expect(readComposerSnapshot({ version: 1, content })).toBeUndefined();
    }
    expect(mentionDraft("legacy __bold__")).toEqual({
      text: "legacy __bold__",
      recipients: [],
    });
  });
  it("round-trips every editable boundary across paragraphs and atomic tokens", () => {
    const original = doc(
      paragraph(schema.text("one")),
      paragraph(
        schema.text("two "),
        schema.nodes.token.create({
          source: "@Honey",
          recipient: { pubkey: "a".repeat(64), name: "Honey" },
        }),
        schema.text("!"),
      ),
    );
    const source = projectComposerDocument(original);
    expect(source.draft.text).toBe("one\ntwo @Honey!");
    for (const offset of [0, 1, 2, 3, 4, 5, 6, 7, 8, 14, 15])
      expect(source.source(source.position(offset)), String(offset)).toBe(
        offset,
      );
    expect(source.draft.recipients).toEqual([
      { pubkey: "a".repeat(64), name: "Honey", start: 8, end: 14 },
    ]);
  });
  it("validates saved provenance rather than inferring a mention from text", () => {
    const token = schema.nodes.token.create({
      source: "@Honey",
      recipient: { pubkey: "invalid", name: "Honey" },
    });
    const draft = mentionDraft(
      projectComposerDocument(doc(paragraph(token))).draft,
    );
    expect(draft.recipients).toEqual([]);
    expect(
      projectComposerDocument(readComposerDocument(draft, [])).draft.recipients,
    ).toEqual([]);
  });
});

describe("composer Markdown boundary", () => {
  it("retains raw source and surrounding whitespace byte-for-byte", () => {
    for (const text of [
      "__bold__ and **bold**",
      "  before\n\n```js\n`literal` *\n```\n",
      "- one\n  - two",
      "> quote\n> line",
      "[**label**](https://example.com)",
      "~~strike~~ ||spoiler||",
    ]) {
      expect(composerMarkdown(mentionDraft(text))).toBe(text);
    }
    expect(serialize(bold("one more "), schema.text("plain"))).toBe(
      "**one more** plain",
    );
  });
  it("uses syntax-aware escaping and delimiter flanking", () => {
    expect(serialize(bold("*"))).toBe("**\\***");
    const output = serialize(schema.text("x"), bold("!"), schema.text("y"));
    expect(fromMarkdown(output).children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "x" },
        { type: "strong", children: [{ type: "text", value: "!" }] },
        { type: "text", value: "y" },
      ],
    });
    expect(serialize(bold("[label](https://example.com)"))).toBe(
      "**[label](https://example.com)**",
    );
  });
});

const marked = (text: string, ...marks: InlineFormat[]) =>
  schema.text(
    text,
    marks.map((name) => schema.marks[name].create()),
  );
const parseFormats = (text: string) =>
  fromMarkdown(text, {
    extensions: [gfmStrikethrough()],
    mdastExtensions: [gfmStrikethroughFromMarkdown()],
  });

// Compare rendered characters and their formats, not one preferred spelling of
// valid Markdown. Generated mark delimiters cannot wrap boundary whitespace.
function renderedCharacters(
  nodes: readonly RootContent[],
  marks: string[] = [],
): { character: string; marks: string[] }[] {
  return nodes.flatMap((node) => {
    const nested = ["strong", "emphasis", "delete"].includes(node.type)
      ? [...marks, node.type].sort()
      : marks;
    if (node.type === "text")
      return [...node.value]
        .filter((character) => !/\s/.test(character))
        .map((character) => ({ character, marks: nested }));
    return "children" in node ? renderedCharacters(node.children, nested) : [];
  });
}

describe("inline formatting batch", () => {
  it("round-trips nested and crossing marks through Markdown and persisted drafts", () => {
    const names = ["bold", "italic", "strike"] as const;
    const types = { bold: "strong", italic: "emphasis", strike: "delete" };
    for (const [left, right] of [
      ["one ", "two"],
      ["a", "b"],
      ["!", "?"],
    ] as const)
      for (let first = 0; first < 8; first++)
        for (let second = 0; second < 8; second++) {
          const a = names.filter((_, index) => first & (1 << index));
          const b = names.filter((_, index) => second & (1 << index));
          const original = doc(
            paragraph(
              marked(left, ...a),
              marked(right, ...b),
              schema.text(" plain"),
            ),
          );
          const draft = mentionDraft(
            JSON.parse(JSON.stringify(projectComposerDocument(original).draft)),
          );
          expect(readComposerDocument(draft, []).eq(original)).toBe(true);
          expect(draft.text).toBe(`${left}${right} plain`);
          const output = composerMarkdown(draft);
          expect(
            renderedCharacters(parseFormats(output).children),
            output,
          ).toEqual([
            ...[...left.trim()].map((character) => ({
              character,
              marks: a.map((name) => types[name]).sort(),
            })),
            ...[...right].map((character) => ({
              character,
              marks: b.map((name) => types[name]).sort(),
            })),
            ...[..."plain"].map((character) => ({ character, marks: [] })),
          ]);
        }
  });
  it("preserves whitespace and existing inline Markdown inside nested formats", () => {
    expect(
      serialize(bold("one "), marked("two", "bold", "italic"), bold(" three")),
    ).toBe("**one _two_ three**");
    expect(
      serialize(marked("~~old~~ and [link](https://example.com)", "italic")),
    ).toBe("_~~old~~ and [link](https://example.com)_");
    expect(
      serialize(marked("one\ntwo ", "italic", "strike"), schema.text("plain")),
    ).toBe("_~~one\ntwo~~_ plain");
  });
  it("escapes literal punctuation in each generated format", () => {
    for (const mark of ["bold", "italic", "strike"] as const)
      for (const character of ["*", "_", "~", "!"]) {
        const output = serialize(
          schema.text("x"),
          marked(character, mark),
          schema.text("y"),
        );
        expect(
          renderedCharacters(parseFormats(output).children),
          output,
        ).toEqual([
          { character: "x", marks: [] },
          {
            character,
            marks: [
              { bold: "strong", italic: "emphasis", strike: "delete" }[mark],
            ],
          },
          { character: "y", marks: [] },
        ]);
      }
  });
  it("uses the same document, stored marks and history for all three formats", () => {
    let state = EditorState.create({
      doc: doc(paragraph(schema.text("text"))),
      plugins: [history()],
    });
    const dispatch = (tr: typeof state.tr) => {
      state = state.apply(tr);
    };
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, 1, 5)));
    for (const name of ["bold", "italic", "strike"] as const) {
      toggleMark(schema.marks[name], null, { removeWhenPresent: false })(
        state,
        (tr) => dispatch(closeHistory(tr)),
      );
    }
    const draft = () => projectComposerDocument(state.doc).draft;
    expect(
      renderedCharacters(parseFormats(composerMarkdown(draft())).children)[0]
        ?.marks,
    ).toEqual(["delete", "emphasis", "strong"]);
    undo(state, dispatch);
    expect(
      state.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name),
    ).toEqual(["bold", "italic"]);
    redo(state, dispatch);
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, 5)));
    dispatch(closeHistory(state.tr.insertText(" more ")));
    expect(draft().text).toBe("text more ");
    expect(
      state.doc.firstChild?.lastChild?.marks.map((mark) => mark.type.name),
    ).toEqual(["bold", "italic", "strike"]);
    expect(composerMarkdown(draft())).toBe("**_~~text more~~_** ");
    toggleMark(schema.marks.italic)(state, dispatch);
    dispatch(state.tr.insertText("end"));
    expect(
      state.doc.firstChild?.lastChild?.marks.map((mark) => mark.type.name),
    ).toEqual(["bold", "strike"]);
  });
});
