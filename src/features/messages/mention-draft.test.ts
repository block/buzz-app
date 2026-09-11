import { expect, it } from "vitest";
import {
  CUSTOM_EMOJI_TOKEN,
  editMentionDraft,
  expandCustomEmoji,
  mentionDraft,
  replaceMentionDraft,
} from "./mention-draft";
const first = { pubkey: "a".repeat(64), name: "Honey", start: 0, end: 6 };
const second = { pubkey: "b".repeat(64), name: "Honey", start: 7, end: 13 };
it("deleting one namesake does not leave its recipient attached to the other", () => {
  const draft = mentionDraft({
    text: "@Honey @Honey help",
    recipients: [first, second],
  });
  const edited = editMentionDraft(draft, "@Honey help");
  // Text alone cannot identify which identical token was deleted. Fail closed.
  expect(edited.recipients).toEqual([]);
});
it("actual edits before a mention move its span; extending or replacing a name drops intent", () => {
  const draft = mentionDraft({ text: "@Honey help", recipients: [first] });
  const edit = (text: string, start: number, end = start) =>
    editMentionDraft(draft, text, {
      text: draft.text,
      start,
      end,
      inputType: "insertText",
    });
  expect(edit("Hi @Honey help", 0).recipients[0]).toMatchObject({
    start: 3,
    end: 9,
  });
  expect(edit("@Honeybee help", 6).recipients).toEqual([]);
  expect(edit("@Honey help me", draft.text.length).recipients).toEqual([first]);
  expect(edit("@Honey help", 0, 6).recipients).toEqual([]);
  expect(editMentionDraft(draft, "Hi @Honey help").recipients).toEqual([]);
  expect(editMentionDraft(draft, draft.text).recipients).toEqual([]);
});
it("legacy prose and malformed persisted metadata never infer recipients", () => {
  expect(mentionDraft("@Honey").recipients).toEqual([]);
  for (const recipient of [
    { ...first, start: -1 },
    { ...first, pubkey: "invalid" },
    { ...first, end: 4 },
  ]) {
    expect(
      mentionDraft({ text: "@Honey", recipients: [recipient] }).recipients,
    ).toEqual([]);
  }
});

it("pasting a namesake while extending the chosen token cannot transfer notification intent", () => {
  const draft = mentionDraft({ text: "@Honey ", recipients: [first] });
  expect(editMentionDraft(draft, "@Honeybee @Honey ").recipients).toEqual([]);
});

it("keeps custom emoji as one editor token and expands only for delivery", () => {
  const draft = mentionDraft({
    text: `${CUSTOM_EMOJI_TOKEN} hello`,
    recipients: [],
    emoji: [{ shortcode: "party-parrot", start: 0, end: 1 }],
  });
  expect(draft.emoji).toEqual([
    { shortcode: "party-parrot", start: 0, end: 1 },
  ]);
  expect(expandCustomEmoji(draft)).toBe(":party-parrot: hello");
  expect(replaceMentionDraft(draft, 0, 1, "").emoji).toBeUndefined();
  expect(editMentionDraft(draft, `${CUSTOM_EMOJI_TOKEN} hello!`).emoji).toEqual(
    [{ shortcode: "party-parrot", start: 0, end: 1 }],
  );
  expect(
    expandCustomEmoji(editMentionDraft(draft, `${CUSTOM_EMOJI_TOKEN} hello!`)),
  ).toBe(":party-parrot: hello!");
});

it("captured replacement ranges never transfer identity across a matrix of same-name edits", () => {
  for (const text of ["@Honey ", "Hi @Honey help", "@Honey @Honey help"]) {
    const start = text.indexOf("@Honey");
    const draft = mentionDraft({
      text,
      recipients: [{ ...first, start, end: start + 6 }],
    });
    for (let from = 0; from <= text.length; from++) {
      for (let to = from; to <= text.length; to++) {
        for (const insertion of [
          "",
          " ",
          "Hi ",
          "@Honey",
          "bee @Honey",
          "@Honey @Honey ",
        ]) {
          const actual = replaceMentionDraft(draft, from, to, insertion);
          const inferred = editMentionDraft(draft, actual.text, {
            text,
            start: from,
            end: to,
            inputType: "insertFromPaste",
          });
          for (const recipient of inferred.recipients)
            expect(
              actual.recipients,
              JSON.stringify({ text, from, to, insertion }),
            ).toContainEqual(recipient);
        }
      }
    }
  }
});
