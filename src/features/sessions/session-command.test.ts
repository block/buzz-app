import { expect, it } from "vitest";
import { isSessionCommand, sessionCommandDraft } from "./session-command";
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
