import { describe, expect, it } from "vitest";
import type { Mark } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { composerSchema as schema } from "./composer-document";
import { applyComposerEmoticon } from "./composer-emoticons";

/** Converts at `end`, an offset into `source`; returns the text, or null when
 * nothing converted. */
function convert(
  source: string,
  {
    end = source.length,
    marks = [] as Mark[],
    block = schema.nodes.paragraph,
  } = {},
) {
  const doc = schema.nodes.doc.create(null, [
    block.create(null, schema.text(source, marks)),
  ]);
  const tr = EditorState.create({ doc }).tr;
  return applyComposerEmoticon(tr, end + 1) ? tr.doc.textContent : null;
}

describe("typed emoticon conversion", () => {
  it.each([
    [":)", "🙂"],
    [":-)", "🙂"],
    [":(", "😞"],
    [";)", "😉"],
    [":D", "😄"],
    [":P", "😛"],
    [";p", "😜"],
    [":'(", "😢"],
    [">:(", "😠"],
    ["<3", "❤️"],
    ["</3", "💔"],
  ])("converts %s", (source, emoji) => {
    expect(convert(source)).toBe(emoji);
  });

  it("converts after whitespace, before the typed space", () => {
    expect(convert("thanks :) ", { end: 9 })).toBe("thanks 🙂 ");
  });

  it.each([
    ["inside a word", "a:)"],
    ["before more text", ":)x", 2],
    ["for text-like forms", "item 8)"],
  ])("keeps it literal %s", (_, source, end?: number) => {
    expect(convert(source, { end })).toBeNull();
  });

  it("keeps it literal in code", () => {
    expect(convert(":)", { marks: [schema.marks.code.create()] })).toBeNull();
    expect(convert(":)", { block: schema.nodes.code_block })).toBeNull();
    expect(convert("`a :) b`", { end: 5 })).toBeNull();
  });
});
