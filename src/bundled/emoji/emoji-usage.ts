import { readView, writeView } from "../../shared/view-state";
import type { EmojiMatch } from "./emoji-search";

const key = "emoji:usage:v1";
const capacity = 256;

/** Local to the account/community, with the most recently chosen IDs retained. */
export function emojiUsage(scope: string): ReadonlyMap<string, number> {
  const saved = readView<unknown>(scope, key, []);
  const usage = new Map<string, number>();
  if (!Array.isArray(saved)) return usage;
  for (const entry of saved.slice(0, capacity)) {
    if (
      Array.isArray(entry) &&
      typeof entry[0] === "string" &&
      /^(unicode|custom)\/.{1,256}$/.test(entry[0]) &&
      Number.isSafeInteger(entry[1]) &&
      entry[1] > 0
    )
      usage.set(entry[0], entry[1]);
  }
  return usage;
}

export function rememberEmoji(scope: string, id: string) {
  const usage = new Map(emojiUsage(scope));
  const count = Math.min((usage.get(id) ?? 0) + 1, Number.MAX_SAFE_INTEGER);
  usage.delete(id);
  // Re-read at selection time so another composer/window's choices are included.
  writeView(scope, key, [[id, count], ...usage].slice(0, capacity));
}

/** Literal exact names lead normalized matches; learn within each remaining tier. */
export function prioritizeEmoji(
  query: string,
  matches: readonly EmojiMatch[],
  usage: ReadonlyMap<string, number>,
): readonly EmojiMatch[] {
  const normalize = (text: string) => text.toLowerCase().replace(/[-_\s]/g, "");
  const literal = query.toLowerCase();
  const needle = normalize(query);
  const tier = (item: EmojiMatch) => {
    if (item.shortcode.toLowerCase() === literal) return 0;
    const name = normalize(item.shortcode);
    return name === needle ? 1 : name.startsWith(needle) ? 2 : 3;
  };
  return [...matches].sort(
    (a, b) =>
      tier(a) - tier(b) || (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0),
  );
}
