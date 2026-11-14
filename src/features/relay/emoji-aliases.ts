import data, { type EmojiMartData } from "@emoji-mart/data";
import type { EventData } from "./events";
import {
  EMOJI_SET,
  EMOJI_SET_KIND,
  contentEmojiTags,
  emojiMatches,
  emojiTags,
  linkPart,
  messageParts,
  normalizeShortcode,
  type CustomEmoji,
} from "./emoji";

/** Proposed coordinate, separate from sets that older clients rewrite. Not yet published. */
export const EMOJI_ALIAS_SET = "buzz:emoji-aliases:v1";
const MAX_ALIASES = 500;
const standard = data as unknown as EmojiMartData;
const unicode = new Set(
  Object.values(standard.emojis).flatMap((emoji) =>
    emoji.skins.flatMap((skin) => (skin.native ? [skin.native] : [])),
  ),
);
const reserved = new Set([
  ...Object.keys(standard.emojis),
  ...Object.keys(standard.aliases),
]);

export type EmojiAliasTarget =
  | Readonly<{ kind: "unicode"; value: string }>
  | Readonly<{ kind: "custom"; author: string; shortcode: string }>;
export type EmojiAlias = Readonly<{
  shortcode: string;
  target: EmojiAliasTarget;
}>;
export type ResolvedEmojiAlias = EmojiAlias &
  Readonly<{ author: string }> &
  (
    | Readonly<{ status: "ready"; text: string; emoji?: CustomEmoji }>
    | Readonly<{ status: "conflict" | "missing-target" }>
  );

/** Strict envelope parsing only; signature, community, membership and write authority
 * remain the transport/relay's responsibility. A malformed set is never partially read. */
export function parseEmojiAliasSet(
  value: unknown,
): readonly EmojiAlias[] | undefined {
  if (!value || typeof value !== "object") return;
  const event = value as Partial<EventData>;
  if (
    event.kind !== EMOJI_SET_KIND ||
    event.content !== "" ||
    !Number.isSafeInteger(event.created_at) ||
    (event.created_at ?? -1) < 0 ||
    !Array.isArray(event.tags) ||
    event.tags.length > MAX_ALIASES + 1 ||
    !Array.isArray(event.tags[0]) ||
    event.tags[0]?.length !== 2 ||
    event.tags[0][0] !== "d" ||
    event.tags[0][1] !== EMOJI_ALIAS_SET
  )
    return;
  const names = new Set<string>();
  const aliases: EmojiAlias[] = [];
  for (const tag of event.tags.slice(1)) {
    if (!Array.isArray(tag) || !tag.every((part) => typeof part === "string"))
      return;
    const [name, shortcode, kind, target, code] = tag;
    if (
      name !== "alias" ||
      !shortcode ||
      normalizeShortcode(shortcode) !== shortcode ||
      names.has(shortcode)
    )
      return;
    names.add(shortcode);
    if (
      tag.length === 4 &&
      kind === "unicode" &&
      target &&
      unicode.has(target)
    ) {
      aliases.push({ shortcode, target: { kind, value: target } });
    } else if (
      tag.length === 5 &&
      kind === "custom" &&
      target &&
      /^[0-9a-f]{64}$/.test(target) &&
      code &&
      normalizeShortcode(code) === code
    ) {
      aliases.push({
        shortcode,
        target: { kind, author: target, shortcode: code },
      });
    } else return;
  }
  return aliases;
}

/** Input must be verified events from ONE community. Collapse replacements before
 * decoding, including empty or malformed replacements, so old entries cannot reappear. */
export function resolveEmojiAliases(
  events: Iterable<EventData>,
): ResolvedEmojiAlias[] {
  const sets = new Map<string, EventData>();
  for (const event of events) {
    const coordinate = event.tags.find(([name]) => name === "d")?.[1];
    if (
      event.kind !== EMOJI_SET_KIND ||
      (coordinate !== EMOJI_SET && coordinate !== EMOJI_ALIAS_SET)
    )
      continue;
    const key = `${event.pubkey}/${coordinate}`;
    const old = sets.get(key);
    if (
      !old ||
      event.created_at > old.created_at ||
      (event.created_at === old.created_at && event.id < old.id)
    )
      sets.set(key, event);
  }
  const custom = new Map<string, readonly CustomEmoji[]>();
  const customNames = new Set<string>();
  const aliases: (EmojiAlias & { author: string })[] = [];
  for (const event of sets.values()) {
    if (event.tags.find(([name]) => name === "d")?.[1] === EMOJI_SET) {
      const entries = emojiTags(event);
      custom.set(event.pubkey, entries);
      for (const entry of entries) customNames.add(entry.shortcode);
    } else {
      for (const alias of parseEmojiAliasSet(event) ?? [])
        aliases.push({ ...alias, author: event.pubkey });
    }
  }
  const counts = new Map<string, number>();
  for (const { shortcode } of aliases)
    counts.set(shortcode, (counts.get(shortcode) ?? 0) + 1);
  return aliases
    .sort(
      (a, b) =>
        a.shortcode.localeCompare(b.shortcode) ||
        a.author.localeCompare(b.author),
    )
    .map((alias): ResolvedEmojiAlias => {
      if (
        counts.get(alias.shortcode) !== 1 ||
        reserved.has(alias.shortcode) ||
        customNames.has(alias.shortcode)
      )
        return { ...alias, status: "conflict" };
      if (alias.target.kind === "unicode")
        return { ...alias, status: "ready", text: alias.target.value };
      const target = alias.target;
      const emoji = custom
        .get(target.author)
        ?.find((entry) => entry.shortcode === target.shortcode);
      return emoji
        ? { ...alias, status: "ready", text: `:${emoji.shortcode}:`, emoji }
        : { ...alias, status: "missing-target" };
    });
}

function ready(alias: ResolvedEmojiAlias) {
  if (alias.status !== "ready")
    throw new Error(
      alias.status === "conflict"
        ? `Emoji alias :${alias.shortcode}: has a conflicting name.`
        : `Emoji alias :${alias.shortcode}: has an unavailable target.`,
    );
  return alias;
}

/** Future send/edit callers run this BEFORE assigning outbox identity. Keep custom
 * alias text and snapshot its URL: a message can mention both an alias and a namesake
 * custom target owned by somebody else, which need different event-local tags. */
export function prepareAliasMessage(
  content: string,
  aliases: readonly ResolvedEmojiAlias[],
  custom: readonly CustomEmoji[],
): { content: string; tags: string[][] } {
  const used = new Map<string, string>();
  // Invalid aliases cannot disable existing custom or built-in shortcodes.
  const entries = [
    ...custom,
    ...aliases.filter((alias) => !reserved.has(alias.shortcode)),
  ];
  const resolved = messageParts(content)
    .map((part) => {
      if (linkPart(part)) return part;
      let result = "",
        end = 0;
      for (const match of emojiMatches(part, entries)) {
        result += part.slice(end, match.start);
        const entry = match.emoji;
        const literal = part.slice(match.start, match.end);
        if ("status" in entry) {
          const alias = ready(entry);
          result += alias.emoji ? literal : alias.text;
          if (alias.emoji) used.set(alias.shortcode, alias.emoji.url);
        } else {
          result += literal;
          used.set(entry.shortcode, entry.url);
        }
        end = match.end;
      }
      return result + part.slice(end);
    })
    .join("");
  return {
    content: resolved,
    tags: [...used].map(([code, url]) => ["emoji", code, url]),
  };
}

/** A single alias reaction uses its target's existing wire identity, so selecting
 * the alias and selecting the target fold into the same reaction group. */
export function prepareAliasReaction(
  content: string,
  aliases: readonly ResolvedEmojiAlias[],
  custom: readonly CustomEmoji[],
): { content: string; tags: string[][] } {
  const token = /^:([a-z0-9_-]{1,64}):$/i.exec(content);
  const code = token?.[1]?.toLowerCase();
  const alias =
    code &&
    !reserved.has(code) &&
    !custom.some((entry) => entry.shortcode === code)
      ? aliases.find((entry) => entry.shortcode === code)
      : undefined;
  if (!alias) return { content, tags: contentEmojiTags(content, custom) };
  const value = ready(alias);
  return {
    content: value.text,
    tags: value.emoji
      ? [["emoji", value.emoji.shortcode, value.emoji.url]]
      : [],
  };
}
