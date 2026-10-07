/**
 * The one rule for matching a typed name to a person or agent name. Mentions,
 * the message search author picker and people pickers use it, so the same
 * text finds the same people everywhere. The normative statement and portable
 * fixtures live in the mention rules (src/bundled/mentions/README.md, section 3).
 */

// Fold one code point: no accents, lowercase, and σ for final ς. Folding each
// code point alone keeps a map from folded text back to the name for
// underlining, and gives the same result as folding the whole name.
const foldPoint = (char: string) =>
  char
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ς/g, "σ");

/** A name or query without accents and case. Keeps spaces at the ends. */
export const foldName = (text: string) => [...text].map(foldPoint).join("");

/** The normalized form for comparing and ordering names. */
export const normalizeName = (text: string) => foldName(text).trim();

export type PersonMatch = {
  /** 0 equal, 1 name starts with the query, 2 a word equals it, 3 a word starts with it. */
  tier: 0 | 1 | 2 | 3;
  /** Code point indexes of `name` that matched, for underlining. */
  positions: number[];
};

const space = /\s/u;

/** How `name` matches `query`, or undefined. An empty query matches at tier 0. */
export function matchPerson(
  name: string,
  query: string,
): PersonMatch | undefined {
  const needle = [...normalizeName(query)];
  // Folded code points of the name, each with the name code points it came
  // from. A code point that folds away (a combining accent) joins the one
  // before it, so an underline never splits a letter from its accent.
  const chars: string[] = [];
  const origin: number[][] = [];
  [...name].forEach((char, index) => {
    const pieces = [...foldPoint(char)];
    if (!pieces.length) origin.at(-1)?.push(index);
    for (const piece of pieces) {
      chars.push(piece);
      origin.push([index]);
    }
  });
  let start = 0;
  let end = chars.length;
  while (start < end && space.test(chars[start] ?? "")) start += 1;
  while (end > start && space.test(chars[end - 1] ?? "")) end -= 1;
  if (!needle.length) return { tier: 0, positions: [] };
  const at = (from: number) =>
    needle.every((char, n) => chars[from + n] === char);
  const found = (tier: PersonMatch["tier"], from: number) => ({
    tier,
    positions: [...new Set(origin.slice(from, from + needle.length).flat())],
  });
  if (end - start === needle.length && at(start)) return found(0, start);
  if (end - start > needle.length && at(start)) return found(1, start);
  let prefix: number | undefined;
  for (let from = start; from < end; from += 1) {
    if (
      space.test(chars[from] ?? "") ||
      (from > start && !space.test(chars[from - 1] ?? ""))
    )
      continue;
    let stop = from;
    while (stop < end && !space.test(chars[stop] ?? "")) stop += 1;
    if (stop - from < needle.length || !at(from)) continue;
    if (stop - from === needle.length) return found(2, from);
    prefix ??= from;
  }
  return prefix === undefined ? undefined : found(3, prefix);
}
