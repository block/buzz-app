import { expect, it } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  composerSchema as schema,
  projectComposerDocument,
} from "./composer-document";
import {
  documentEditorDraft,
  documentEditorMarkdown,
} from "./document-editor-markdown";

it("loads formatting into the existing editor and retains its meaning on save", () => {
  const markdown =
    "First **bold** and *italic* with [a link](https://example.com).\n\n- One\n- Two\n\n> Quoted\n\n```ts\nconst a = 1;\n```";
  const draft = documentEditorDraft(markdown);
  expect(draft.document).toBeDefined();
  const strip = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(strip)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== "position")
              .map(([key, item]) => [key, strip(item)]),
          )
        : value;
  expect(strip(fromMarkdown(documentEditorMarkdown(draft)))).toEqual(
    strip(fromMarkdown(markdown)),
  );
});
it.each([
  "# Heading\n\nParagraph",
  "~~removed~~",
  "**`code`**",
  ">",
  "https://example.com",
  "- ```ts\n  const a = 1;\n  ```",
  "| Column | Value |\n| --- | --- |\n| A | B |",
  "- [x] Completed\n- [ ] Pending",
  "![Image](https://example.com/image.png)",
  "[reference][id]\n\n[id]: https://example.com",
  "<script>alert(1)</script>",
  "[Unsafe](javascript:alert%281%29)",
  "\\*literal stars\\* and `inline`",
])("preserves unsupported or literal source: %s", (markdown) => {
  expect(documentEditorMarkdown(documentEditorDraft(markdown))).toBe(markdown);
});

it("keeps oversized and deeply nested input as literal source without Markdown parsing", () => {
  for (const markdown of ["x".repeat(200_000), `${"> ".repeat(1000)}nested`]) {
    const draft = documentEditorDraft(markdown);
    expect(draft.text).toBe(markdown);
    expect(draft.document).toBeUndefined();
  }
});

const semanticTree = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(semanticTree)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "position")
            .map(([key, child]) => [key, semanticTree(child)]),
        )
      : value;

it.each([
  "> First point\n>\n> Second point\n\nEnd",
  "> > Nested first\n> >\n> > Nested second\n>\n> Outer last",
  "- First item\n\n  Second paragraph\n\n- Next item",
  "- One\n\n- Two",
  "- Outer\n  - Inner\n  - Next",
  "> - One\n>   - Nested\n> - Two",
  "- Item\n  > First\n  >\n  > Second",
  "1. Item\n\n   > First\n   >\n   > Second\n\n2. Next",
  "First  \nSecond",
  "First\\\nSecond",
  "> First  \n> Second",
  "- First\\\n  Second",
  "**First\\\nSecond**",
  "[First\\\nSecond](https://example.com)",
  "First\\\nSecond `code`",
  "First\\\n`code`",
  "> First\\\n> Second `code`",
  "- First\\\n  Second `code`",
])(
  "preserves CommonMark paragraph and hard-break structure: %s",
  (markdown) => {
    expect(
      semanticTree(
        fromMarkdown(documentEditorMarkdown(documentEditorDraft(markdown))),
      ),
    ).toEqual(semanticTree(fromMarkdown(markdown)));
  },
);

it("keeps structural paragraphs even in a list item with tight defaults", () => {
  const item = schema.nodes.list_item.create(null, [
    schema.nodes.paragraph.create(null, schema.text("First")),
    schema.nodes.paragraph.create(null, schema.text("Second")),
  ]);
  const doc = schema.nodes.doc.create(
    null,
    schema.nodes.bullet_list.create(null, item),
  );
  const markdown = documentEditorMarkdown(projectComposerDocument(doc).draft);
  expect(semanticTree(fromMarkdown(markdown))).toEqual(
    semanticTree(fromMarkdown("- First\n\n  Second")),
  );
});

it.each([1, 2, 3])(
  "preserves a typed trailing backslash run of %s before a hard break",
  (count) => {
    const prefix = `C:${"\\".repeat(count)}`;
    const doc = schema.nodes.doc.create(
      null,
      schema.nodes.paragraph.create(null, [
        schema.text(prefix),
        schema.nodes.hard_break.create(),
        schema.text("next"),
      ]),
    );
    expect(
      semanticTree(
        fromMarkdown(
          documentEditorMarkdown(projectComposerDocument(doc).draft),
        ),
      ),
    ).toEqual(semanticTree(fromMarkdown(`${prefix}  \nnext`)));
  },
);
