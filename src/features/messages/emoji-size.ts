import { createContext } from "react";
import type { Appearance } from "../../shared/theme/service";
import type { CustomEmoji } from "../relay/emoji";

/** The saved emoji size, which conversations can change in place. Absent in
    previews and tests, where emoji-only messages show no size handle. */
export type EmojiSizePreference = Pick<
  Appearance,
  "subscribe" | "snapshot" | "setEmojiSize"
>;
export const EmojiSizeContext = createContext<EmojiSizePreference | undefined>(
  undefined,
);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiPresentation =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\d#*]\uFE0F?\u20E3/u;

function renderedEmoji(value: string, entries: readonly CustomEmoji[]): string {
  if (!value.includes(":")) return value;
  const custom = new Set(entries.map((entry) => entry.shortcode.toLowerCase()));
  return value.replace(
    /:([a-z0-9_-]{1,64}):/gi,
    (literal, shortcode: string) =>
      custom.has(shortcode.toLowerCase()) ? "😀" : literal,
  );
}

export function isUnicodeEmojiOnly(value: string) {
  const content = value.trim();
  if (!content || !emojiPresentation.test(content)) return false;
  for (const { segment } of graphemes.segment(content)) {
    if (/^\s+$/u.test(segment)) continue;
    if (!emojiPresentation.test(segment)) return false;
  }
  return true;
}

export const isEmojiOnly = (
  value: string,
  entries: readonly CustomEmoji[] = [],
) => isUnicodeEmojiOnly(renderedEmoji(value, entries));

/** Most emoji a message can hold and still show large. More than this reads
    as a run of text, so it keeps text size. */
export const MAX_LARGE_EMOJI = 9;

export function usesLargeEmojiPresentation(
  value: string,
  entries: readonly CustomEmoji[] = [],
) {
  const rendered = renderedEmoji(value, entries);
  if (!isUnicodeEmojiOnly(rendered)) return false;
  let count = 0;
  for (const { segment } of graphemes.segment(rendered.trim()))
    if (!/^\s+$/u.test(segment) && ++count > MAX_LARGE_EMOJI) return false;
  return true;
}
