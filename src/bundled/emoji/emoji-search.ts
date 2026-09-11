import type { EmojiMartData } from "@emoji-mart/data";
import type { CustomEmoji } from "../../features/relay/emoji";

export type EmojiMatch = Readonly<{
  id: string;
  shortcode: string;
  name: string;
  text: string;
  url?: string;
}>;
type Standard = EmojiMatch & { terms: readonly string[] };
const normalize = (value: string) => value.toLowerCase().replace(/[-_\s]/g, "");
let standard: Promise<readonly Standard[]> | undefined;

/** Data only: never initialize or query Emoji Mart's mutable picker singleton. */
function loadStandard() {
  standard ??= import("@emoji-mart/data")
    .then(({ default: raw }) => {
      // The package declares the shape but omits its JSON default export.
      const data = raw as unknown as EmojiMartData;
      const aliases = new Map<string, string[]>();
      for (const [alias, id] of Object.entries(data.aliases)) {
        const values = aliases.get(id) ?? [];
        values.push(alias);
        aliases.set(id, values);
      }
      return Object.values(data.emojis).flatMap((emoji) => {
        const native = emoji.skins[0]?.native;
        return native
          ? [
              {
                id: `unicode/${emoji.id}`,
                shortcode: emoji.id,
                name: emoji.name,
                text: native,
                terms: [
                  emoji.id,
                  ...(aliases.get(emoji.id) ?? []),
                  emoji.name,
                  ...emoji.keywords,
                ],
              },
            ]
          : [];
      });
    })
    .catch((error: unknown) => {
      standard = undefined; // A failed chunk load remains retryable.
      throw error;
    });
  return standard;
}
function score(query: string, terms: readonly string[]) {
  let best = 4;
  for (const term of terms) {
    const value = normalize(term);
    best = Math.min(
      best,
      value === query
        ? 0
        : value.startsWith(query)
          ? 1
          : value.includes(query)
            ? 2
            : 4,
    );
  }
  return best;
}

/** Bounded combined ranking; custom and Unicode collisions retain distinct IDs. */
export async function searchEmoji(
  query: string,
  custom: readonly CustomEmoji[],
  limit = 20,
): Promise<readonly EmojiMatch[]> {
  const native = await loadStandard();
  return rankEmoji(query, native, custom, limit);
}
export function searchCustomEmoji(
  query: string,
  custom: readonly CustomEmoji[],
  limit = 20,
): readonly EmojiMatch[] {
  return rankEmoji(query, [], custom, limit);
}
function rankEmoji(
  query: string,
  native: readonly Standard[],
  custom: readonly CustomEmoji[],
  limit: number,
): readonly EmojiMatch[] {
  const needle = normalize(query);
  if (!needle) return [];
  const candidates: Standard[] = [
    ...native,
    ...custom.map(({ shortcode, url }) => ({
      id: `custom/${shortcode}`,
      shortcode,
      name: `:${shortcode}:`,
      text: `:${shortcode}:`,
      url,
      terms: [shortcode],
    })),
  ];
  return candidates
    .map((item) => ({
      item,
      rank: score(needle, item.terms),
      codeRank: score(needle, [item.shortcode]),
    }))
    .filter(({ rank }) => rank < 4)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.codeRank - b.codeRank ||
        a.item.id.localeCompare(b.item.id),
    )
    .slice(0, Math.max(0, Math.min(limit, 50)))
    .map(({ item: { terms: _terms, ...item } }) => item);
}
