import type { CustomEmoji } from "../relay/emoji";
import { CUSTOM_EMOJI_TOKEN, type DraftEmoji } from "./mention-draft";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiPresentation =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\d#*]\uFE0F?\u20E3/u;

export function isSingleUnicodeEmoji(value: string) {
  const content = value.trim();
  if (!content || !emojiPresentation.test(content)) return false;
  const segments = graphemes.segment(content)[Symbol.iterator]();
  return !segments.next().done && segments.next().done;
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

export const isSingleEmoji = (
  value: string,
  entries: readonly CustomEmoji[] = [],
) => isSingleUnicodeEmoji(value) || !!singleCustomEmoji(value, entries);
