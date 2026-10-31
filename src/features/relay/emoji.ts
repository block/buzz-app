import type { EventData } from "./events.ts";

export type CustomEmoji = Readonly<{ shortcode: string; url: string }>;
export const EMOJI_SET = "buzz:custom-emoji";
export const EMOJI_SET_KIND = 30030;
/** A member's emoji span parts: part 0 keeps the legacy `d`, so older clients
 * still read it; part n ≥ 1 is `buzz:custom-emoji:n`. One event cannot carry a
 * large palette under the relay's frame limit, and an edit republishes only its part. */
export const emojiSetD = (part: number) =>
  part === 0 ? EMOJI_SET : `${EMOJI_SET}:${part}`;
export function emojiSetPart(d: string | undefined): number | undefined {
  if (d === EMOJI_SET) return 0;
  const part = /^buzz:custom-emoji:([1-9]\d{0,3})$/.exec(d ?? "")?.[1];
  return part === undefined ? undefined : Number(part);
}
const CUSTOM_REACTION = /^:([a-z0-9_-]{1,64}):$/i;
/** Reaction text stays small, while a valid custom token gets its two delimiters. */
export function validReactionContent(value: string): boolean {
  return [...value].length <= 64 || CUSTOM_REACTION.test(value);
}
export function normalizeShortcode(value: string): string | undefined {
  const code = value
    .trim()
    .replace(/^:+|:+$/g, "")
    .toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(code) ? code : undefined;
}
/** Desktop's file-first naming: drop the extension and collapse invalid runs to `_`. */
export function suggestShortcode(filename: string): string | undefined {
  return normalizeShortcode(
    filename
      .trim()
      .replace(/^.*[/\\]/, "")
      .replace(/\.[^.]*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[_-]+|[_-]+$/g, ""),
  );
}
/** Broker admission for one part of a member's own set: canonical unique entries. */
export function validEmojiSetTemplate(
  event: unknown,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const e = event as Partial<EventData> | null;
  if (
    e?.kind !== EMOJI_SET_KIND ||
    e.content !== "" ||
    !Number.isSafeInteger(e.created_at) ||
    (e.created_at ?? -1) < 0 ||
    (e.created_at ?? 0) > now + 300 ||
    !Array.isArray(e.tags) ||
    e.tags[0]?.length !== 2 ||
    e.tags[0][0] !== "d" ||
    emojiSetPart(e.tags[0][1]) === undefined
  )
    return false;
  const codes = new Set<string>();
  for (const tag of e.tags.slice(1)) {
    if (!Array.isArray(tag) || tag.length !== 3) return false;
    const [name, code, url] = tag;
    if (
      name !== "emoji" ||
      typeof code !== "string" ||
      normalizeShortcode(code) !== code ||
      codes.has(code) ||
      typeof url !== "string" ||
      !url ||
      url !== url.trim() ||
      url.length > 2048
    )
      return false;
    codes.add(code);
  }
  return true;
}
/** Original URLs belong in events; display URLs are resolved by session.media. */
export function emojiTags(
  event: Pick<EventData, "tags">,
): readonly CustomEmoji[] {
  const entries = new Map<string, CustomEmoji>();
  for (const [name, value, url] of event.tags) {
    if (name !== "emoji" || !value || !url?.trim()) continue;
    const shortcode = normalizeShortcode(value);
    if (shortcode && !entries.has(shortcode))
      entries.set(shortcode, Object.freeze({ shortcode, url: url.trim() }));
  }
  return Object.freeze([...entries.values()]);
}
/** Share token boundaries with the renderer: never substitute inside HTTP(S) links. */
export const messageParts = (content: string) =>
  content.split(/(https?:\/\/[^\s<>"`]+)/g);
export const linkPart = (part: string) => /^https?:\/\//.test(part);
const shortcodePattern = () => /(?=(:([a-zA-Z0-9_-]{1,64}):))/g;
const indexes = new WeakMap<
  readonly CustomEmoji[],
  ReadonlyMap<string, CustomEmoji>
>();
/** A community catalog can hold 100k entries: look shortcodes up through an
 * index built once per (immutable) entries array, never a linear scan. */
export function findCustomEmoji(
  entries: readonly CustomEmoji[],
  shortcode: string,
): CustomEmoji | undefined {
  let index = indexes.get(entries);
  if (!index) {
    const built = new Map<string, CustomEmoji>();
    for (const entry of entries)
      if (!built.has(entry.shortcode)) built.set(entry.shortcode, entry);
    index = built;
    indexes.set(entries, index);
  }
  return index.get(shortcode.toLowerCase());
}
export function* emojiMatches(
  content: string,
  entries: readonly CustomEmoji[],
) {
  let end = 0;
  for (const match of content.matchAll(shortcodePattern())) {
    if (match.index < end) continue;
    const emoji = findCustomEmoji(entries, match[2] ?? "");
    if (!emoji) continue;
    end = match.index + (match[1]?.length ?? 0);
    yield { emoji, start: match.index, end };
  }
}
export function referencedEmoji(content: string): string[] {
  return [
    ...new Set(
      messageParts(content).flatMap((part) =>
        linkPart(part)
          ? []
          : [...part.matchAll(shortcodePattern())].map((m) =>
              (m[2] ?? "").toLowerCase(),
            ),
      ),
    ),
  ];
}
