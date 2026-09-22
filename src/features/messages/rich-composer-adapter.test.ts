// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown } from "./MessageMarkdown";
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

it("rejects oversized direct, formatted and completion edits without changing the draft", () => {
  const value = adapter(mentionDraft("x".repeat(16000)));
  const before = value.snapshot().draft;
  value.editor.commands.insertContent("z");
  expect(value.snapshot().draft).toEqual(before);
  value.editor.commands.selectAll();
  value.editor.commands.toggleBold();
  expect(value.snapshot().draft).toEqual(before);
  value.setEditingSelection(16000);
  const observation = value.observation();
  if (!observation) throw new Error("Missing observation");
  expect(value.replaceEditingRange(observation, 16000, 16000, "z")).toBe(false);
  expect(value.snapshot().draft).toEqual(before);
});

it("rejects the 33rd identity before it becomes visible or loses notification metadata", () => {
  const value = adapter();
  for (let index = 0; index < 32; index++)
    expect(
      value.insertMention(index.toString(16).padStart(64, "0"), `User${index}`),
    ).toBe(true);
  const before = value.snapshot().draft;
  expect(value.insertMention("f".repeat(64), "Extra")).toBe(false);
  expect(value.snapshot().draft).toEqual(before);
  expect(value.snapshot().draft.recipients).toHaveLength(32);
});

it("locks direct commands and undo while disabled, then restores editing", () => {
  const value = adapter(mentionDraft("saved"));
  value.editor.commands.insertContent(" edit");
  const before = value.snapshot().draft;
  value.setEditable(false);
  value.editor.commands.insertContent("bad");
  value.editor.commands.selectAll();
  value.editor.commands.toggleBold();
  value.editor.commands.undo();
  expect(value.snapshot().draft).toEqual(before);
  value.setEditable(true);
  expect(value.editor.commands.undo()).toBe(true);
  expect(value.snapshot().draft.text).toBe("saved");
});

it.each([
  "**:party:**",
  "before **:party:**",
  "before [:party:](https://example.com)",
])(
  "keeps catalog-only emoji changes out of undo and preserves source and marks: %s",
  (source) => {
    const value = adapter(mentionDraft(source));
    const entries = [
      { shortcode: "party", url: "https://emoji.test/party.png" },
    ];
    value.setEmoji(entries, (url) => url);
    expect(
      value.editor.view.dom.querySelectorAll("img[data-composer-emoji]"),
    ).toHaveLength(1);
    expect(value.snapshot().draft.text).toBe(source);
    expect(value.editor.commands.undo()).toBe(false);
    value.setEmoji([], (url) => url);
    expect(value.snapshot().draft.text).toBe(source);
    expect(value.editor.commands.undo()).toBe(false);
  },
);

it("preserves authored trailing breaks when sending and restoring a draft", () => {
  const value = adapter(mentionDraft("line"));
  value.editor.commands.setHardBreak();
  value.editor.commands.setHardBreak();
  expect(value.snapshot().draft.text).toBe("line\n\n");
  expect(adapter(value.snapshot().draft).snapshot().draft).toEqual(
    value.snapshot().draft,
  );
});

it("refreshes read-only emoji previews without editing content or decorating code", () => {
  const value = adapter(mentionDraft(":party:"));
  value.setEditable(false);
  value.setEmoji(
    [{ shortcode: "party", url: "https://emoji.test/party.png" }],
    (url) => url,
  );
  expect(
    value.editor.view.dom.querySelectorAll("img[data-composer-emoji]"),
  ).toHaveLength(1);
  expect(value.snapshot().draft.text).toBe(":party:");
  value.setEmoji([], (url) => url);
  expect(
    value.editor.view.dom.querySelectorAll("img[data-composer-emoji]"),
  ).toHaveLength(0);
  expect(value.snapshot().draft.text).toBe(":party:");

  const code = adapter(mentionDraft("```\n:party:\n```"));
  code.setEmoji(
    [{ shortcode: "party", url: "https://emoji.test/party.png" }],
    (url) => url,
  );
  expect(code.editor.view.dom.querySelectorAll("img")).toHaveLength(0);
  expect(code.snapshot().draft.text).toBe("```\n:party:\n```");
});

it("preserves literal code line continuations when serializing and restoring", () => {
  const source = "```sh\necho first\\\n  && echo second\n```";
  const value = adapter(mentionDraft(source));
  expect(value.snapshot().draft.text).toBe(source);
  expect(adapter(value.snapshot().draft).snapshot().draft.text).toBe(source);
});

it("restores recipient marks from the replaced text rather than its preceding boundary", () => {
  const source = mentionDraft({
    text: "before **@Alex**",
    recipients: [{ pubkey: "a".repeat(64), name: "Alex", start: 9, end: 14 }],
  });
  expect(adapter(source).snapshot().draft).toEqual(source);
});

// Exercise both consumers of the outgoing draft: persisted editor and message renderer.
it.each([
  { href: "https://example.com/", label: "&copy; <tag> &amp; &#169;" },
  { href: "https://example.com/?x=1&copy;=2", label: "design" },
  { href: "https://example.com/?x=1&#169;=2", label: "design" },
  { href: "https://example.com/a(b)?x=1&other=2", label: "design" },
  { href: "https://example.com/hello%20world", label: "design" },
  {
    href: "https://example.com/?x=1&copy;=2",
    label: "https://example.com/?x=1&copy;=2",
  },
  {
    href: "https://example.com/?x=1&#169;=2",
    label: "https://example.com/?x=1&#169;=2",
  },
])(
  "preserves link text and destination $href ($label) through delivery and draft restoration",
  ({ href, label }) => {
    const value = adapter();
    value.editor.commands.insertContent({
      type: "text",
      text: label,
      marks: [{ type: "link", attrs: { href } }],
    });
    const draft = value.snapshot().draft;
    const restored = adapter(draft);
    expect(restored.snapshot().editingText).toBe(label);
    expect(
      restored.editor.getJSON().content?.[0]?.content?.[0]?.marks,
    ).toContainEqual(
      expect.objectContaining({
        type: "link",
        attrs: expect.objectContaining({ href }),
      }),
    );
    const output = document.createElement("div");
    output.innerHTML = renderToStaticMarkup(
      createElement(MessageMarkdown, {
        row: {
          id: "message",
          channelId: "channel",
          authorId: "author",
          content: draft.text,
          createdAt: 1,
          mentions: [],
          participants: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
          emoji: [],
        },
        media: () => undefined,
        onOpenLink: () => false,
        canOpenLink: () => true,
      }),
    );
    expect(output.querySelector("a")?.getAttribute("href")).toBe(href);
    expect(output.textContent).toBe(label);
    expect(restored.snapshot().draft).toEqual(draft);
  },
);

it.each(["paragraph", "codeBlock"])(
  "preserves literal character references in %s",
  (type) => {
    const value = adapter();
    const text = "&copy; <tag> &amp; &#169;";
    value.editor.commands.setContent({
      type: "doc",
      content: [{ type, content: [{ type: "text", text }] }],
    });
    const restored = adapter(value.snapshot().draft);
    expect(restored.editor.state.doc.firstChild?.textContent).toBe(text);
  },
);
it("preserves character references in inline code", () => {
  const value = adapter();
  const text = "&copy; <tag> &amp; &#169;";
  value.editor.commands.insertContent({
    type: "text",
    text,
    marks: [{ type: "code" }],
  });
  expect(adapter(value.snapshot().draft).snapshot().editingText).toBe(text);
});
