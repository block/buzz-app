// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { RichComposerAdapter } from "./rich-composer-adapter";
import { mentionDraft } from "./mention-draft";

const mounted: RichComposerAdapter[] = [];
function adapter(draft = mentionDraft("")) {
  const element = document.createElement("div");
  document.body.append(element);
  const value = new RichComposerAdapter(element, draft);
  mounted.push(value);
  return value;
}
afterEach(() => {
  for (const value of mounted.splice(0)) value.destroy();
  document.body.replaceChildren();
});

it("keeps completion text independent from Markdown and edits inside formatting", () => {
  const value = adapter();
  value.editor.commands.insertContent("hello !wo");
  value.setEditingSelection(0, 9);
  value.editor.commands.toggleBold();
  value.setEditingSelection(9);

  const observation = value.observation();
  expect(observation).toMatchObject({ text: "hello !wo", start: 9, end: 9 });
  if (!observation) throw new Error("Expected an editable observation");
  expect(value.replaceEditingRange(observation, 6, 9, "world")).toBe(true);
  expect(value.snapshot().draft.text).toBe("**hello world**");
});

it("preserves explicit recipient identity through formatting, undo, and restore", () => {
  const value = adapter();
  expect(value.insertMention("a".repeat(64), "A]lice")).toBe(true);
  value.editor.commands.insertContent("first\nsecond");
  value.setEditingSelection(0, 7);
  value.editor.commands.toggleBold();
  const formatted = value.snapshot().draft;
  expect(formatted.text).toContain("@A]lice");
  expect(formatted.recipients).toEqual([
    expect.objectContaining({ pubkey: "a".repeat(64), name: "A]lice" }),
  ]);

  value.editor.commands.undo();
  const undone = value.snapshot().draft;
  expect(undone.recipients).toHaveLength(1);
  const restored = adapter(formatted).snapshot().draft;
  expect(restored).toEqual(formatted);
  const escaped = mentionDraft({
    text: "**@A]lice**\n\n[a\\]b](https://example.com)",
    recipients: [{ pubkey: "a".repeat(64), name: "A]lice", start: 2, end: 9 }],
  });
  expect(adapter(escaped).snapshot().draft).toEqual(escaped);
  const recipient = restored.recipients[0];
  expect(recipient && restored.text.slice(recipient.start, recipient.end)).toBe(
    "@A]lice",
  );
});

it("never authorizes recipients from pasted plain text, HTML, or identity links", () => {
  for (const content of [
    "@Honey",
    '<span data-recipient-chip data-pubkey="bbbb">@Honey</span>',
    '<a href="buzz://person/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">@Honey</a>',
  ]) {
    const value = adapter();
    value.editor.commands.setContent(content);
    expect(value.snapshot().draft.recipients).toEqual([]);
  }
});

it("rejects stale completion evidence after the document or editor state changes", () => {
  const value = adapter();
  value.editor.commands.insertContent("!query");
  value.setEditingSelection(6);
  const stale = value.observation();
  if (!stale) throw new Error("Expected an editable observation");
  value.editor.commands.insertContent("x");
  expect(value.replaceEditingRange(stale, 0, 6, "result")).toBe(false);
  expect(value.snapshot().editingText).toBe("!queryx");
});

it("rejects editing commands while read-only and exposes document revisions", () => {
  const value = adapter();
  value.editor.commands.insertContent("!query");
  const before = value.snapshot();
  const observation = value.observation();
  if (!observation) throw new Error("Expected an editable observation");
  value.setEditable(false);
  expect(value.observation()).toBeUndefined();
  expect(value.replaceEditingRange(observation, 0, 6, "result")).toBe(false);
  expect(value.snapshot().editingText).toBe("!query");
  value.setEditable(true);
  value.editor.commands.insertContent(" next");
  expect(value.snapshot().revision).toBeGreaterThan(before.revision);
});

it("maps real hard breaks in editing text and recipient spans", () => {
  const value = adapter();
  value.editor.commands.insertContent("first");
  value.editor.commands.setHardBreak();
  expect(value.insertMention("a".repeat(64), "Alex")).toBe(true);
  value.editor.commands.insertContent(":sm");

  expect(value.snapshot()).toMatchObject({ editingText: "first\n@Alex :sm" });
  const draft = value.snapshot().draft;
  expect(draft.text).toBe("first\n@Alex :sm");
  expect(draft.recipients).toEqual([
    { pubkey: "a".repeat(64), name: "Alex", start: 6, end: 11 },
  ]);
  const restored = adapter(draft);
  expect(restored.snapshot().draft).toEqual(draft);
  restored.editor.commands.insertContent("hi");
  expect(restored.snapshot().draft).toEqual(
    mentionDraft({
      text: "first\n@Alex :smhi",
      recipients: [{ pubkey: "a".repeat(64), name: "Alex", start: 6, end: 11 }],
    }),
  );
});

it("treats a restored draft as the undo baseline", () => {
  const draft = mentionDraft({
    text: "saved @Alex",
    recipients: [{ pubkey: "a".repeat(64), name: "Alex", start: 6, end: 11 }],
  });
  const value = adapter(draft);
  expect(value.editor.commands.undo()).toBe(false);
  expect(value.snapshot().draft).toEqual(draft);

  value.editor.commands.insertContent(" changed");
  expect(value.editor.commands.undo()).toBe(true);
  expect(value.snapshot().draft).toEqual(draft);
});

it.each(["a & b", "<tag>", "**literal**"])(
  "inserts completion text literally: %s",
  (replacement) => {
    const value = adapter();
    value.editor.commands.insertContent("!q");
    value.setEditingSelection(2);
    const observation = value.observation();
    if (!observation) throw new Error("Expected an editable observation");
    expect(value.replaceEditingRange(observation, 0, 2, replacement)).toBe(
      true,
    );
    expect(value.snapshot().editingText).toBe(replacement);
  },
);

it("does not confuse authored marker-like text with recipient serialization", () => {
  const marker = "\uE000recipient:1\uE001";
  const value = adapter();
  value.editor.commands.insertContent(`${marker} before `);
  expect(value.insertMention("a".repeat(64), "Alex")).toBe(true);
  value.editor.commands.insertContent("after");
  const draft = value.snapshot().draft;
  expect(draft.text).toBe(`${marker} before @Alex after`);
  expect(draft.recipients).toEqual([
    {
      pubkey: "a".repeat(64),
      name: "Alex",
      start: marker.length + 8,
      end: marker.length + 13,
    },
  ]);
  expect(adapter(draft).snapshot().draft).toEqual(draft);
});

it("rejects ranges inside recipient atoms and other invalid ranges", () => {
  const value = adapter();
  expect(value.insertMention("a".repeat(64), "Alex")).toBe(true);
  value.editor.commands.insertContent("hi");
  value.setEditingSelection(value.snapshot().editingText.length);
  const observation = value.observation();
  if (!observation) throw new Error("Expected an editable observation");

  for (const [start, end] of [
    [2, 3],
    [-1, 0],
    [100, 101],
    [4, 2],
  ] as const) {
    expect(value.replaceEditingRange(observation, start, end, "x")).toBe(false);
    expect(value.snapshot().editingText).toBe("@Alex hi");
  }
});

it("avoids restore markers produced by Markdown entity decoding", () => {
  const text = "&#xE000;recipient:1&#xE001; before @Alex";
  const value = adapter(
    mentionDraft({
      text,
      recipients: [
        { pubkey: "a".repeat(64), name: "Alex", start: 35, end: 40 },
      ],
    }),
  );
  const restored = value.snapshot().draft;
  expect(restored.recipients).toEqual([
    { pubkey: "a".repeat(64), name: "Alex", start: 21, end: 26 },
  ]);
  expect(restored.text).toBe("\uE000recipient:1\uE001 before @Alex");
});

it("preserves rich Markdown structure while restoring trailing editing space", () => {
  const fenced = mentionDraft("```ts\nconst x = 1\n```");
  expect(adapter(fenced).snapshot().draft).toEqual(fenced);

  const formatted = adapter(mentionDraft("**literal <tag>**"));
  expect(formatted.snapshot().editingText).toBe("literal <tag>");
  expect(formatted.editor.isActive("bold")).toBe(true);
});

it("drops nonrepresentable recipient metadata without exposing markers", () => {
  const text = "[link](https://example.com/@Alex)";
  const value = adapter(
    mentionDraft({
      text,
      recipients: [
        { pubkey: "a".repeat(64), name: "Alex", start: 27, end: 32 },
      ],
    }),
  );
  expect(value.snapshot().editingText).toBe("link");
  expect(value.snapshot().draft.recipients).toEqual([]);
  expect(value.snapshot().draft.text).not.toContain("recipient:");
});
