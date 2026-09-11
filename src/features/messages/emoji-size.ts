import type { CustomEmoji } from "../relay/emoji";
import { CUSTOM_EMOJI_TOKEN, type DraftEmoji } from "./mention-draft";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiPresentation =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\d#*]\uFE0F?\u20E3/u;

export function isUnicodeEmojiOnly(value: string) {
  const content = value.trim();
  if (!content || !emojiPresentation.test(content)) return false;
  for (const { segment } of graphemes.segment(content)) {
    if (/^\s+$/u.test(segment)) continue;
    if (!emojiPresentation.test(segment)) return false;
  }
  return true;
}

export function singleCustomEmoji(
  value: string,
  entries: readonly CustomEmoji[],
) {
  const match = /^:([a-z0-9_-]{1,64}):$/i.exec(value.trim());
  return match
    ? entries.find((entry) => entry.shortcode === match[1]?.toLowerCase())
    : undefined;
}

export function singleCustomEmojiToken(
  value: string,
  tokens: readonly DraftEmoji[],
  entries: readonly CustomEmoji[],
) {
  if (value.trim() !== CUSTOM_EMOJI_TOKEN || tokens.length !== 1)
    return undefined;
  const token = tokens[0];
  return token
    ? entries.find((entry) => entry.shortcode === token.shortcode)
    : undefined;
}

export function leadingCustomEmojiToken(
  value: string,
  tokens: readonly DraftEmoji[],
  entries: readonly CustomEmoji[],
) {
  const token = tokens.find(
    (item) =>
      item.start === 0 &&
      item.end === CUSTOM_EMOJI_TOKEN.length &&
      value.startsWith(CUSTOM_EMOJI_TOKEN),
  );
  return token
    ? entries.find((entry) => entry.shortcode === token.shortcode)
    : undefined;
}

export const isEmojiOnly = (
  value: string,
  entries: readonly CustomEmoji[] = [],
) => {
  const custom = new Set(entries.map((entry) => entry.shortcode.toLowerCase()));
  const rendered = value.replace(
    /:([a-z0-9_-]{1,64}):/gi,
    (literal, shortcode: string) =>
      custom.has(shortcode.toLowerCase()) ? "😀" : literal,
  );
  return isUnicodeEmojiOnly(rendered);
};
