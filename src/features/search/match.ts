// Combining marks (the vowel sign in "की") belong to the letter before them.
const isWordChar = (char: string | undefined) =>
  /[\p{L}\p{M}\p{N}]/u.test(char ?? "");

/** One letter, with any marks on it ("q", or "की" with its vowel sign). */
const oneLetter = (word: string) =>
  [...word.replace(/\p{M}/gu, "")].length === 1;

/** How well a label matches typed text, best first. Ranks are whole numbers,
 * so callers can order them and add fractional tie-breaks. */
export const MatchRank = {
  exact: 0,
  prefix: 1,
  /** The text starts a later word. */
  wordStart: 2,
  substring: 3,
  /** Each letter continues a run that began at a word start ("tlp" in
   * "team-launch-planning"). */
  wordRuns: 4,
  /** Each typed word appears in the name, in any order ("team buzz" in
   * "buzz-hive-team"). Words split on spaces and punctuation. */
  words: 5,
} as const;
export type MatchRank = (typeof MatchRank)[keyof typeof MatchRank];

/** How well a label matches typed text (`MatchRank`), or undefined for no
 * match. `positions` are the matched code points of the label, for
 * underlining. */
export function matchName(
  label: string,
  needle: string,
): { rank: MatchRank; positions: number[] } | undefined {
  const text = label.toLowerCase();
  const chars = [...text];
  // Lowercasing can change a label's length (İ → i̇). Rank it, but do not
  // underline positions that would land on the wrong letters.
  const aligned = chars.length === [...label].length;
  const found = (rank: MatchRank, positions: number[]) => ({
    rank,
    positions: aligned ? positions : [],
  });
  const run = (at: number, typed = needle) => {
    const from = [...text.slice(0, at)].length;
    return Array.from({ length: [...typed].length }, (_, n) => from + n);
  };
  if (text === needle) return found(MatchRank.exact, run(0));
  let substring: number | undefined;
  for (
    let at = text.indexOf(needle);
    at >= 0;
    at = text.indexOf(needle, at + 1)
  ) {
    if (at === 0) return found(MatchRank.prefix, run(0));
    if (!isWordChar(text[at - 1])) return found(MatchRank.wordStart, run(at));
    substring ??= at;
  }
  if (substring !== undefined)
    return found(MatchRank.substring, run(substring));
  // Spaces in typed text only separate words; they need not match.
  const letters = [...needle.replace(/\s+/g, "")];
  if (!letters.length) return undefined;
  // Word runs need the letters in order, so a name without them skips the
  // word-run search.
  let inOrder = 0;
  for (const char of chars) if (char === letters[inOrder]) inOrder += 1;
  // Can letters[i..] match chars[j..] with every run starting at a word start?
  // `inRun` means the previous letter matched chars[j - 1].
  const memo = new Map<number, boolean>();
  const takes = (i: number, j: number, inRun: boolean) =>
    chars[j] === letters[i] &&
    (inRun || !isWordChar(chars[j - 1])) &&
    wordRuns(i + 1, j + 1, true);
  const wordRuns = (i: number, j: number, inRun: boolean): boolean => {
    if (i === letters.length) return true;
    if (j === chars.length) return false;
    const key = (i * (chars.length + 1) + j) * 2 + (inRun ? 1 : 0);
    const known = memo.get(key);
    if (known !== undefined) return known;
    const result = takes(i, j, inRun) || wordRuns(i, j + 1, false);
    memo.set(key, result);
    return result;
  };
  if (inOrder === letters.length && wordRuns(0, 0, false)) {
    // Replay the same choices the search made: take a letter when it leads
    // to a full match, otherwise skip the character.
    const positions: number[] = [];
    for (let i = 0, j = 0, inRun = false; i < letters.length; j += 1) {
      inRun = takes(i, j, inRun);
      if (inRun) {
        positions.push(j);
        i += 1;
      }
    }
    return found(MatchRank.wordRuns, positions);
  }
  // Last, each typed word must appear whole, preferably where a word starts.
  // Scattered single letters never match.
  const words = needle.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  if (!words.length) return undefined;
  const positions = new Set<number>();
  for (const word of words) {
    // A one-letter word ("q" in "q&a", or "की" with its vowel sign) matches
    // only a one-letter word, so it cannot land inside a longer one.
    const single = oneLetter(word);
    const whole = (at: number) =>
      !isWordChar(text[at - 1]) &&
      (!single || !isWordChar(text[at + word.length]));
    let at = text.indexOf(word);
    const inside = single ? -1 : at;
    while (at >= 0 && !whole(at)) at = text.indexOf(word, at + 1);
    if (at < 0) at = inside;
    if (at < 0) return undefined;
    for (const position of run(at, word)) positions.add(position);
  }
  return found(
    MatchRank.words,
    [...positions].sort((a, b) => a - b),
  );
}

export const matchRank = (label: string, needle: string) =>
  matchName(label, needle)?.rank;

/** The words of typed text. Each is a search term of its own. */
export const searchTerms = (needle: string) =>
  needle.split(/\s+/u).filter(Boolean);

/** Where the ranks of rows found only word by word begin: after every row
 * that matches the whole typed text, whatever its caller adds to that rank
 * (field penalties here; relationship bands, ten apart, in people search). */
export const TERMS_APART = 100;

/** One text a row can be found by, and its own rule for typed text: how well
 * that text matches a label, and the code points it covers. */
export type Field = {
  label: string;
  match: (
    label: string,
    text: string,
  ) => { rank: number; positions: number[] } | undefined;
};

/**
 * A field matched by the name rule (`matchName`). Text that is not the row's
 * own name takes a `cap`, the loosest rank that still matches, and a
 * `penalty` added to its rank. `rank` gives every match one rank instead.
 */
export const nameField = (
  label: string | undefined,
  options: { cap?: MatchRank; penalty?: number; rank?: number } = {},
): Field => ({
  label: label ?? "",
  match: (text, needle) => {
    const found = matchName(text, needle);
    return found && found.rank <= (options.cap ?? MatchRank.words)
      ? {
          rank: options.rank ?? found.rank + (options.penalty ?? 0),
          positions: found.positions,
        }
      : undefined;
  },
});

/** The best rank of one piece of text among a row's fields, else Infinity. */
const bestRank = (fields: readonly Field[]) => (text: string) =>
  Math.min(
    ...fields.map(({ label, match }) => match(label, text)?.rank ?? Infinity),
  );

/** Stands in for a code point another word holds. It is not a letter, so it
 * ends words as a separator does, and nothing typed matches it. */
const HELD = "\u0000";
/** How many places `placeTerms` tries for one row. A few typed words need a
 * handful. The bound is for text such as one letter typed many times. */
const PLACE_TRIES = 200;

type Place = {
  rank: number;
  field: number;
  positions: number[];
  fragments: string[];
};

/**
 * A place in the row for each typed word, no two in the same fragment, or
 * undefined. A fragment is a run of letters, marks and digits in one field:
 * "team-ops" has two, "quality" one. A word holds every fragment its match
 * touches, so initials hold each word they start. A word of one letter takes
 * only a place that starts a fragment. The result is the assignment whose
 * weakest word ranks best, from `from` up, and among those the one that keeps
 * each word in the earliest field that can hold it.
 */
function placeTerms(
  terms: readonly string[],
  fields: readonly Field[],
  from: number,
): { rank: number; places: Place[] } | undefined {
  const texts = fields.map(({ label, match }, field) => {
    // Lowercased as the rules compare it, so every match has its positions.
    const chars = [...label.toLowerCase()];
    let fragment = -1;
    return {
      match,
      chars,
      aligned: chars.length === [...label].length,
      fragments: chars.map((char, at) =>
        isWordChar(char)
          ? `${field}:${isWordChar(chars[at - 1]) ? fragment : ++fragment}`
          : undefined,
      ),
    };
  });
  let tries = PLACE_TRIES;
  // The next rank worth allowing: the best one a search turned down.
  let next = Infinity;
  // Each field's rule finds its best match in what is left of the label, so
  // the first field that matches within `limit` gives the word's place.
  const find = (term: string, closed: ReadonlySet<string>, limit: number) => {
    for (const [field, text] of texts.entries()) {
      const found = text.match(
        text.chars
          .map((char, at) =>
            closed.has(text.fragments[at] ?? "") ? HELD : char,
          )
          .join(""),
        term,
      );
      if (!found) continue;
      // One typed letter must start its fragment. A rule's best match is
      // inside a word only when no word of the field starts with the letter.
      if (
        oneLetter(term) &&
        isWordChar(text.chars[(found.positions[0] ?? 0) - 1])
      )
        continue;
      if (found.rank > limit) next = Math.min(next, found.rank);
      else
        return {
          rank: found.rank,
          field,
          positions: text.aligned ? found.positions : [],
          fragments: [
            ...new Set(
              found.positions.flatMap((at) => text.fragments[at] ?? []),
            ),
          ],
        };
    }
    return undefined;
  };
  // `taken` fragments hold earlier words. `avoid` holds the ones this word
  // gave up so that a later word could have them.
  const place = (
    index: number,
    taken: readonly string[],
    avoid: readonly string[],
    limit: number,
  ): Place[] | undefined => {
    const term = terms[index];
    if (term === undefined) return [];
    if (tries-- <= 0) return undefined;
    const here = find(term, new Set([...taken, ...avoid]), limit);
    if (!here) return undefined;
    const rest = place(index + 1, [...taken, ...here.fragments], [], limit);
    if (rest) return [here, ...rest];
    // Any other place that helps leaves one of these fragments free.
    for (const fragment of here.fragments) {
      const moved = place(index, taken, [...avoid, fragment], limit);
      if (moved) return moved;
    }
    return undefined;
  };
  for (let limit = from; Number.isFinite(limit); limit = next) {
    next = Infinity;
    const places = place(0, [], [], limit);
    if (places) return { rank: limit, places };
  }
  return undefined;
}

/**
 * A row's rank for typed text, or undefined. `fields` are the texts the row
 * can be found by, each with its own rule, cap and penalty. `rank` is the
 * row's rule for one piece of text, by default the best of its fields, and
 * undefined or Infinity for no match.
 *
 * The whole text is tried first, so a row it matches ranks as before. Failing
 * that, text of several words matches when every word does, in any order,
 * each in any of the row's fields and no two in the same fragment
 * (`placeTerms`): a typed space says the words are different words of the
 * row. Such a row ranks by its weakest word, `TERMS_APART` later. One word is
 * only ever the whole text.
 */
export function rankTerms(
  needle: string,
  fields: readonly Field[],
  rank: (text: string) => number | undefined = bestRank(fields),
): number | undefined {
  const found = (text: string) => {
    const value = rank(text);
    return value !== undefined && Number.isFinite(value) ? value : undefined;
  };
  const whole = found(needle);
  if (whole !== undefined) return whole;
  const terms = searchTerms(needle);
  if (terms.length < 2) return undefined;
  let weakest = 0;
  for (const term of terms) {
    const value = found(term);
    if (value === undefined) return undefined;
    weakest = Math.max(weakest, value);
  }
  const placed = placeTerms(terms, fields, weakest);
  return placed && TERMS_APART + placed.rank;
}

/**
 * The code points of a row's shown label, its first field, to underline for
 * typed text: where the whole text matches it or, failing that, the places
 * in it that the row's words were found through (`placeTerms`). A word placed
 * in another field underlines nothing, and a word no field holds is left out,
 * as when a chat is listed for its agent. A match looser than `cap` is not
 * underlined.
 */
export function matchedPositions(
  needle: string,
  fields: readonly Field[],
  cap = Infinity,
): number[] | undefined {
  const [shown] = fields;
  const whole = shown?.match(shown.label, needle);
  if (whole && whole.rank <= cap) return whole.positions;
  const terms = searchTerms(needle);
  if (terms.length < 2) return undefined;
  const rank = bestRank(fields);
  const held = terms.filter((term) => Number.isFinite(rank(term)));
  const placed = placeTerms(held, fields, Math.max(0, ...held.map(rank)));
  const positions = new Set(
    placed?.places.flatMap((place) =>
      place.field === 0 && place.rank <= cap ? place.positions : [],
    ),
  );
  return positions.size ? [...positions].sort((a, b) => a - b) : undefined;
}
