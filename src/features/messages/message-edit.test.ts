import { assert, describe, expect, it } from "vitest";
import { shareMessageRows } from "../relay/row-identity";
import { foldMessages } from "../relay/fold";
import { profileTarget } from "../profiles/target";
import {
  messageEditContent,
  messageEditDraft,
  messageEditText,
} from "./message-edit";
import type { EventData } from "../relay/events";
import {
  forwardBody,
  forwardTag,
  snapshotMessage,
} from "../relay/forwarded-message";

const author = "a".repeat(64),
  person = "b".repeat(64);
const original: EventData = {
  id: "c".repeat(64),
  pubkey: author,
  kind: 9,
  created_at: 1,
  content: "Hello @Sam\n\n![photo](https://example.com/photo.png)",
  tags: [
    ["h", "room"],
    ["p", person],
    ["imeta", "url https://example.com/photo.png", "m image/png"],
  ],
};
function firstRow(events: EventData[]) {
  const row = foldMessages("room", author, events)[0];
  assert.exists(row);
  return row;
}
const profiles = new Map([[person, { id: person, name: "Sam" }]]);

describe("message edit round trips", () => {
  it("retains attachment Markdown and binds existing exact mention identities", () => {
    const row = firstRow([original]);
    expect(row.content).not.toContain("![photo]");
    const draft = messageEditText(row, profiles);
    expect(draft).toContain(`[@Sam](${profileTarget(person)})`);
    expect(draft).toContain("![photo](https://example.com/photo.png)");
    const edit = {
      ...original,
      id: "d".repeat(64),
      kind: 40003,
      created_at: 2,
      content: draft.replace("Hello", "Hi"),
      tags: [
        ["h", "room"],
        ["e", original.id],
        ["imeta", "url https://example.com/photo.png", "m image/png"],
      ],
    };
    const edited = firstRow([original, edit]);
    expect(edited.attachments).toEqual(row.attachments);
    expect(edited.mentions).toEqual([person]);
    expect(messageEditText(edited, profiles)).toBe(edit.content);
  });
  it("starts from the latest edit rather than the original body", () => {
    const edit = {
      ...original,
      id: "d".repeat(64),
      kind: 40003,
      created_at: 2,
      content: "New text",
      tags: [
        ["h", "room"],
        ["e", original.id],
      ],
    };
    expect(messageEditText(firstRow([original, edit]), profiles)).toBe(
      "New text",
    );
  });
  it("never binds names in an old edit using original recipients", () => {
    const row = firstRow([original]);
    expect(messageEditText({ ...row, edited: true }, profiles)).toBe(
      original.content,
    );
  });
  it("never infers a recipient from unbound prose", () => {
    const row = firstRow([{ ...original, tags: [["h", "room"]] }]);
    expect(messageEditText(row, profiles)).toBe(original.content);
  });
  it.each([
    "[ref]: <https://example.com/a @Sam>",
    '[ref]: https://example.com "Ask @Sam"',
    "<!-- @Sam -->",
    '<span title="@Sam">Hi</span>',
    '[[a]](https://example.com "See @Sam")',
    '[a](https://example.com\n "See @Sam")',
    "[hello\n@Sam](https://example.com)",
    ">     @Sam",
  ])("links a name beside literal Markdown, not inside it: %s", (literal) => {
    const content = `<b>@Sam</b>\n\n${literal}`;
    const tags = [
      ["h", "room"],
      ["p", person],
    ];
    expect(
      messageEditText(firstRow([{ ...original, content, tags }]), profiles),
    ).toBe(`<b>[@Sam](${profileTarget(person)})</b>\n\n${literal}`);
  });
});

describe("message edit attachments", () => {
  const file = "https://example.com/report.pdf";
  const sent: EventData = {
    ...original,
    content: `Hello\n\n![photo](<https://example.com/photo.png>)\n\n[report.pdf](<${file}>)`,
    tags: [
      ["h", "room"],
      ["imeta", "url https://example.com/photo.png", "m image/png"],
      ["imeta", `url ${file}`, "m application/pdf"],
    ],
  };
  const editOf = (content: string, tags: string[][]): EventData => ({
    ...sent,
    id: "d".repeat(64),
    kind: 40003,
    created_at: 2,
    content,
    tags: [["h", "room"], ["e", sent.id], ...tags],
  });

  it("edits prose without attachment Markdown and restores kept attachments", () => {
    const row = firstRow([sent]);
    const draft = messageEditDraft(row, profiles);
    expect(draft.text).toBe("Hello");
    expect(draft.attachments.map(({ attachment }) => attachment.url)).toEqual([
      "https://example.com/photo.png",
      file,
    ]);
    const content = messageEditContent("Hi", draft.attachments);
    expect(content).toBe(sent.content.replace("Hello", "Hi"));
    const edited = firstRow([sent, editOf(content, sent.tags.slice(1))]);
    expect(edited.attachments).toEqual(row.attachments);
    expect(edited.content).toBe("Hi");
  });

  it("removes an attachment the edit no longer keeps", () => {
    const draft = messageEditDraft(firstRow([sent]), profiles);
    const kept = draft.attachments.filter(
      ({ attachment }) => attachment.url === file,
    );
    const content = messageEditContent(draft.text, kept);
    expect(content).toBe(`Hello\n\n[report.pdf](<${file}>)`);
    const edited = firstRow([sent, editOf(content, sent.tags.slice(2))]);
    expect(edited.attachments.map(({ url }) => url)).toEqual([file]);
  });

  it("keeps image Markdown that places no attachment in the prose", () => {
    const row = firstRow([
      {
        ...sent,
        content: `Hello ![x](http://example.org/a.png)\n\n${sent.content}`,
      },
    ]);
    expect(messageEditDraft(row, profiles).text).toBe(
      "Hello ![x](http://example.org/a.png)\n\nHello",
    );
  });

  it("removes a Markdown-only image by dropping its Markdown", () => {
    const gif = "![party](https://example.com/party.gif)";
    const row = firstRow([
      { ...original, content: `Hi\n\n${gif}`, tags: [["h", "room"]] },
    ]);
    const draft = messageEditDraft(row, profiles);
    expect(draft.text).toBe("Hi");
    expect(
      draft.attachments.map(({ markdown }) => markdown.map(({ text }) => text)),
    ).toEqual([[gif]]);
    expect(messageEditContent(draft.text, draft.attachments)).toBe(
      `Hi\n\n${gif}`,
    );
    expect(messageEditContent(draft.text, [])).toBe("Hi");
  });

  it("cuts a removed image out of the kept link that wraps it", () => {
    const image = "https://example.com/photo.png";
    const row = firstRow([
      { ...sent, content: `Caption [![private](${image})](${file})` },
    ]);
    const draft = messageEditDraft(row, profiles);
    expect(draft.text).toBe("Caption");
    const kept = draft.attachments.filter(
      ({ attachment }) => attachment.url === file,
    );
    const content = messageEditContent(draft.text, kept);
    expect(content).not.toContain(image);
    const edited = firstRow([sent, editOf(content, sent.tags.slice(2))]);
    expect(edited.attachments.map(({ url }) => url)).toEqual([file]);
  });

  it("keeps a forward's quoted media in place and its card intact", () => {
    const source = firstRow([sent]);
    const snapshot = snapshotMessage(source, "Sam");
    const forward: EventData = {
      ...sent,
      id: "f".repeat(64),
      content: forwardBody(snapshot, "Look"),
      tags: [["h", "room"], forwardTag(snapshot), ...sent.tags.slice(1)],
    };
    const row = firstRow([forward]);
    assert.exists(row.forward);
    const draft = messageEditDraft(row, profiles);
    expect(draft.attachments).toEqual([]);
    expect(draft.locked).toEqual(row.attachments.map(({ url }) => url));
    const content = messageEditContent(
      draft.text.replace("Look", "See"),
      draft.attachments,
    );
    const edited = firstRow([
      forward,
      {
        ...editOf(content, []),
        tags: [["h", "room"], ["e", forward.id], ...sent.tags.slice(1)],
      },
    ]);
    expect(edited.forward?.note).toBe("See");
    expect(edited.attachments).toEqual(row.attachments);
  });

  it("keeps metadata for attachments a text-only edit still places", () => {
    const edited = firstRow([
      sent,
      editOf(`Hi\n\n[report.pdf](<${file}>)`, []),
    ]);
    expect(edited.attachments).toEqual([
      expect.objectContaining({ url: file, mime: "application/pdf" }),
    ]);
    expect(edited.content).toBe("Hi");
  });

  it("treats an edit's empty attachment set as authoritative", () => {
    const edited = firstRow([sent, editOf("Hello", [])]);
    expect(edited.attachments).toEqual([]);
    expect(edited.attachmentSourceId).toBe("d".repeat(64));
  });
});

it("row sharing retains latest editable source even when attachment rendering is unchanged", () => {
  const edit = {
    ...original,
    id: "d".repeat(64),
    kind: 40003,
    created_at: 2,
    tags: [
      ["h", "room"],
      ["e", original.id],
    ],
    content: "Updated ![photo](https://example.com/photo.png)",
  };
  const previous = foldMessages("room", author, [original, edit]);
  const next = foldMessages("room", author, [
    original,
    {
      ...edit,
      id: "e".repeat(64),
      created_at: 3,
      content: "Updated ![photo](<https://example.com/photo.png>)",
    },
  ]);
  const shared = shareMessageRows(previous, next);
  assert.exists(shared[0]);
  expect(messageEditText(shared[0], profiles)).toBe(
    "Updated ![photo](<https://example.com/photo.png>)",
  );
  expect(shareMessageRows(next, next)[0]).toBe(next[0]);
});
