import { expect, it } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { composerMarkdown } from "./composer-markdown";
import { documentEditorDraft } from "./document-editor-markdown";

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
  expect(strip(fromMarkdown(composerMarkdown(draft)))).toEqual(
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
  expect(composerMarkdown(documentEditorDraft(markdown))).toBe(markdown);
});

it("keeps oversized and deeply nested input as literal source without Markdown parsing", () => {
  for (const markdown of ["x".repeat(200_000), `${"> ".repeat(1000)}nested`]) {
    const draft = documentEditorDraft(markdown);
    expect(draft.text).toBe(markdown);
    expect(draft.document).toBeUndefined();
  }
});
