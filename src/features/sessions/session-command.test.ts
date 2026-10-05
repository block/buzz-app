import { expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import {
  composerSchema,
  readComposerDocument,
  projectComposerDocument,
} from "../messages/composer-document";
import {
  isSessionCommand,
  sessionCommandDraft,
  sessionCommandContent,
  sameSessionCommandDraft,
} from "./session-command";
import { mentionDraft } from "../messages/mention-draft";

it.each([
  " /session @Agent go",
  "x /session @Agent go",
  "/sessions @Agent go",
  "/session-help",
  "`/session`",
  "https://x/session",
])("leaves literal/non-prefix %s unchanged", (text) => {
  expect(isSessionCommand(text)).toBe(false);
  expect(sessionCommandDraft(mentionDraft(text))).toBeUndefined();
});
it("strips only the exact prefix and whitespace using UTF-16 mention offsets", () => {
  const text = "/session \n\t@🤖Agent help 🌈 @Person";
  const recipients = ["🤖Agent", "Person"].map((name, i) => ({
    pubkey: String(i + 1).repeat(64),
    name,
    start: text.indexOf(`@${name}`),
    end: text.indexOf(`@${name}`) + name.length + 1,
  }));
  const result = sessionCommandDraft({ text, recipients });
  expect(result?.text).toBe("@🤖Agent help 🌈 @Person");
  expect(result?.recipients).toEqual(
    recipients.map((item) => ({
      ...item,
      start: item.start - 11,
      end: item.end - 11,
    })),
  );
});
it("bare command is recognized but has no prompt; typed names never create recipients", () => {
  expect(sessionCommandDraft(mentionDraft("/session \n"))).toEqual({
    text: "",
    recipients: [],
  });
  expect(sessionCommandDraft(mentionDraft("/session @Agent work"))).toEqual({
    text: "@Agent work",
    recipients: [],
  });
});

it("compares hydrated payloads without discarding recipient or rich-document changes", () => {
  const raw = {
    text: "/session @Agent help",
    recipients: [{ pubkey: "a".repeat(64), name: "Agent", start: 9, end: 15 }],
  };
  const doc = readComposerDocument(raw, raw.recipients);
  const rich = projectComposerDocument(doc).draft;
  expect(sameSessionCommandDraft(raw, JSON.parse(JSON.stringify(rich)))).toBe(
    true,
  );
  expect(sameSessionCommandDraft(raw, { ...raw, recipients: [] })).toBe(false);
  const bold = projectComposerDocument(
    EditorState.create({ doc }).tr.addMark(
      projectComposerDocument(doc).position(raw.text.indexOf("help")),
      projectComposerDocument(doc).position(raw.text.length),
      composerSchema.marks.bold.create(),
    ).doc,
  ).draft;
  expect(bold.text).toBe(raw.text);
  expect(sameSessionCommandDraft(raw, bold)).toBe(false);
  expect(sessionCommandContent(bold)).toBe("@Agent **help**");
});
it("strips rich command whitespace across paragraphs and retains prompt structure", () => {
  const doc = composerSchema.node("doc", null, [
    composerSchema.node("paragraph", null, [composerSchema.text("/session ")]),
    composerSchema.node("paragraph", null, [
      composerSchema.text("  @Agent "),
      composerSchema.text("help", [composerSchema.marks.bold.create()]),
    ]),
    composerSchema.node("blockquote", null, [
      composerSchema.node("paragraph", null, [composerSchema.text("details")]),
    ]),
  ]);
  expect(sessionCommandContent(projectComposerDocument(doc).draft)).toBe(
    "@Agent **help**\n\n> details",
  );
});
