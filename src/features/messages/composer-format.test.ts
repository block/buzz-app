import { fromMarkdown } from "mdast-util-from-markdown";
import { expect, it } from "vitest";
import { formatComposerDraft, markdownLink } from "./composer-format";

it("formats selected text while preserving exact recipient intent", () => {
  const pubkey = "a".repeat(64);
  const edit = formatComposerDraft(
    {
      text: "Hello @Alex",
      recipients: [{ pubkey, name: "Alex", start: 6, end: 11 }],
    },
    0,
    11,
    "bold",
  );
  expect(edit.draft).toEqual({
    text: "**Hello @Alex**",
    recipients: [{ pubkey, name: "Alex", start: 8, end: 13 }],
  });
});

it("prefixes every selected line for block formatting", () => {
  const edit = formatComposerDraft(
    { text: "one\ntwo", recipients: [] },
    0,
    7,
    "bullet",
  );
  expect(edit.draft.text).toBe("- one\n- two");
});

it("keeps surrounding whitespace outside inline formatting and toggles it", () => {
  const draft = { text: "@Honey ", recipients: [] };
  const applied = formatComposerDraft(draft, 0, draft.text.length, "bold");
  expect(applied.draft.text).toBe("**@Honey** ");
  expect(fromMarkdown(applied.draft.text).children[0]).toMatchObject({
    children: [{ type: "strong", children: [{ value: "@Honey" }] }],
  });
  expect(
    formatComposerDraft(
      applied.draft,
      applied.selectionStart,
      applied.selectionEnd,
      "bold",
    ).draft.text,
  ).toBe("@Honey ");
});

it("uses Markdown delimiters that preserve selected text meaning", () => {
  const italic = formatComposerDraft(
    { text: "hello", recipients: [] },
    1,
    4,
    "italic",
  );
  expect(italic.draft.text).toBe("h*ell*o");
  expect(fromMarkdown(italic.draft.text).children[0]).toMatchObject({
    children: [
      { type: "text", value: "h" },
      { type: "emphasis", children: [{ type: "text", value: "ell" }] },
      { type: "text", value: "o" },
    ],
  });

  const combined = formatComposerDraft(
    { text: "**hello**", recipients: [] },
    2,
    7,
    "italic",
  );
  expect(combined.draft.text).toBe("***hello***");
  expect(fromMarkdown(combined.draft.text).children[0]).toMatchObject({
    children: [
      {
        type: "emphasis",
        children: [{ type: "strong", children: [{ value: "hello" }] }],
      },
    ],
  });
  expect(
    formatComposerDraft(
      combined.draft,
      combined.selectionStart,
      combined.selectionEnd,
      "italic",
    ).draft.text,
  ).toBe("**hello**");

  const code = formatComposerDraft(
    { text: "foo `bar`", recipients: [] },
    0,
    9,
    "code",
  );
  expect(fromMarkdown(code.draft.text).children[0]).toMatchObject({
    children: [{ type: "inlineCode", value: "foo `bar`" }],
  });
});

it("serializes link labels and destinations without changing their meaning", () => {
  for (const [label, url] of [
    ["x]y", "https://example.com/a)b"],
    ["a*b*c", "https://example.com/?x=1&copy;=2"],
  ] as const) {
    const source = markdownLink(label, url);
    expect(fromMarkdown(source).children[0]).toMatchObject({
      children: [
        {
          type: "link",
          url,
          children: [{ type: "text", value: label }],
        },
      ],
    });
  }
});
