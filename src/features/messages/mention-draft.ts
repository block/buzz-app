export type MentionRecipient = Readonly<{ pubkey: string; name: string }>;
export type DraftRecipient = MentionRecipient &
  Readonly<{ start: number; end: number }>;
export type DraftEmoji = Readonly<{
  shortcode: string;
  start: number;
  end: number;
}>;
export type MentionDraft = {
  text: string;
  recipients: readonly DraftRecipient[];
  emoji?: readonly DraftEmoji[];
};
export const CUSTOM_EMOJI_TOKEN = "\uFFFC";
const boundary = (text: string, end: number) =>
  end === text.length || /[\s.,!?;:()[\]{}]/u.test(text[end] ?? "");
/** Old text-only drafts remain text-only: restoring prose never creates notifications. */
export function mentionDraft(value: unknown): MentionDraft {
  if (typeof value === "string") return { text: value, recipients: [] };
  if (!value || typeof value !== "object") return { text: "", recipients: [] };
  const { text, recipients, emoji } = value as Record<string, unknown>;
  if (typeof text !== "string") return { text: "", recipients: [] };
  const safe = Array.isArray(recipients)
    ? recipients.filter(
        (item): item is DraftRecipient =>
          !!item &&
          typeof item === "object" &&
          typeof item.pubkey === "string" &&
          /^[0-9a-f]{64}$/.test(item.pubkey) &&
          typeof item.name === "string" &&
          !!item.name.trim() &&
          Number.isInteger(item.start) &&
          Number.isInteger(item.end) &&
          item.start >= 0 &&
          item.end <= text.length &&
          text.slice(item.start, item.end) === `@${item.name}` &&
          boundary(text, item.end),
      )
    : [];
  const safeEmoji = Array.isArray(emoji)
    ? emoji.filter(
        (item): item is DraftEmoji =>
          !!item &&
          typeof item === "object" &&
          typeof item.shortcode === "string" &&
          /^[a-z0-9_-]{1,64}$/.test(item.shortcode) &&
          Number.isInteger(item.start) &&
          Number.isInteger(item.end) &&
          item.end === item.start + CUSTOM_EMOJI_TOKEN.length &&
          item.start >= 0 &&
          item.end <= text.length &&
          text.slice(item.start, item.end) === CUSTOM_EMOJI_TOKEN,
      )
    : [];
  return {
    text,
    recipients: safe
      .slice(0, 32)
      .map(({ pubkey, name, start, end }) => ({ pubkey, name, start, end })),
    ...(safeEmoji.length
      ? {
          emoji: safeEmoji.map(({ shortcode, start, end }) => ({
            shortcode,
            start,
            end,
          })),
        }
      : {}),
  };
}
/** Known editor replacement keeps only untouched spans. */
export function replaceMentionDraft(
  value: MentionDraft,
  start: number,
  end: number,
  inserted: string,
): MentionDraft {
  const text = value.text.slice(0, start) + inserted + value.text.slice(end);
  const delta = inserted.length - (end - start);
  return mentionDraft({
    text,
    recipients: value.recipients.flatMap((item) => {
      if (item.end <= start) return [item];
      if (item.start >= end)
        return [{ ...item, start: item.start + delta, end: item.end + delta }];
      return [];
    }),
    emoji: (value.emoji ?? []).flatMap((item) => {
      if (item.end <= start) return [item];
      if (item.start >= end)
        return [{ ...item, start: item.start + delta, end: item.end + delta }];
      return [];
    }),
  });
}
export type MentionEdit = Readonly<{
  text: string;
  start: number;
  end: number;
  inputType: string;
}>;
/** Preserve identity only when the browser supplied the actual replacement range.
 * Matching before/after prose cannot distinguish a paste from untouched text. */
export function editMentionDraft(
  value: MentionDraft,
  text: string,
  edit?: MentionEdit,
): MentionDraft {
  if (
    edit?.text === value.text &&
    Number.isInteger(edit.start) &&
    Number.isInteger(edit.end) &&
    edit.start >= 0 &&
    edit.end >= edit.start &&
    edit.end <= value.text.length
  ) {
    const insertion = [
      "insertText",
      "insertFromPaste",
      "insertLineBreak",
    ].includes(edit.inputType);
    const selectionDeletion =
      edit.inputType.startsWith("delete") && edit.end > edit.start;
    // Collapsed word/grapheme deletion, IME and history operations have no reliable
    // textarea target range. They fail closed instead of reconstructing one.
    const length = text.length - (value.text.length - (edit.end - edit.start));
    if (
      (insertion || (selectionDeletion && length === 0)) &&
      length >= 0 &&
      text.slice(0, edit.start) === value.text.slice(0, edit.start) &&
      text.slice(edit.start + length) === value.text.slice(edit.end)
    )
      return replaceMentionDraft(
        value,
        edit.start,
        edit.end,
        text.slice(edit.start, edit.start + length),
      );
  }
  // Browser autocorrection/history can omit a trustworthy target range. Keep
  // opaque custom-emoji tokens outside the single changed span, while still
  // dropping recipient intent because ordinary prose cannot prove identity.
  let prefix = 0;
  while (
    prefix < value.text.length &&
    prefix < text.length &&
    value.text[prefix] === text[prefix]
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < value.text.length - prefix &&
    suffix < text.length - prefix &&
    value.text[value.text.length - suffix - 1] ===
      text[text.length - suffix - 1]
  )
    suffix += 1;
  const reconciled = replaceMentionDraft(
    value,
    prefix,
    value.text.length - suffix,
    text.slice(prefix, text.length - suffix),
  );
  return { ...reconciled, recipients: [] };
}

export function expandCustomEmoji(value: MentionDraft) {
  let text = value.text;
  for (const item of [...(value.emoji ?? [])].sort((a, b) => b.start - a.start))
    text = `${text.slice(0, item.start)}:${item.shortcode}:${text.slice(item.end)}`;
  return text;
}
