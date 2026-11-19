// Speech recognition writes unfamiliar names (products, jargon, people) as
// ordinary words that sound like them. A rough sound key, the consonants as
// they are usually said, links what was heard to the names that sound like
// it, so the decision provider is told about the link instead of having to
// hear it from spelling.

/** Common words in a spoken request, never treated as a name. */
const FILLER = new Set(
  "a an and about at be can channel chat chats conversation dm dms for from go going had have i in is it its jump let me message messages my of on open please show take talk talking that the thread to us was we where with".split(
    " ",
  ),
);

const VOWELS = /[aeiouy]/g;

/** A word's sound: its consonants as usually said, with near sounds merged
 * (c/k/q, s/z/x, f/v/ph, l/r) and vowels left out. */
export function soundKey(word: string): string {
  let text = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!text) return "";
  text = text
    .replace(/^kn|^gn|^pn|^wr/, (pair) => pair.slice(1))
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/sch/g, "sk")
    .replace(/(sh|ch|tch)/g, "x")
    .replace(/dg(?=[eiy])/g, "j")
    .replace(/g(?=[eiy])/g, "j")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/[cq]/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/v/g, "f")
    .replace(/r/g, "l")
    .replace(/gh/g, "")
    .replace(/[wh]/g, "")
    .replace(VOWELS, "");
  return text.replace(/(.)\1+/g, "$1");
}

/** A name's words, split at spaces, punctuation and lower-to-upper case. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

const SHORTEST_KEY = 2;
/** Keys this short match many words, so their first vowel must match too. */
const SHORT_KEY = 2;
const LONGEST_RUN = 3;

const firstVowel = (word: string) =>
  (word.toLowerCase().match(/[aeiouy]/)?.[0] ?? "").replace("y", "i");

/** What was said that sounds like a name, or like one of its words, without
 * already being spelled that way: "colonel" for a #kernel channel. */
export function soundsLike(spoken: string, name: string): string[] {
  const said = spoken
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((word) => word.replace(/'s$|'/g, ""))
    .filter(Boolean);
  const words = nameWords(name).map((word) => word.toLowerCase());
  const literal = new Set(words);
  // A word with no vowel ("prs") is said letter by letter, not as spelled.
  const sayable = words.filter((word) => /[aeiouy]/.test(word));
  const targets = [...sayable, sayable.join("")]
    .map((word) => ({ key: soundKey(word), vowel: firstVowel(word) }))
    .filter(({ key }) => key.length >= SHORTEST_KEY);
  const sounds = (word: string) => {
    const key = soundKey(word);
    const vowel = firstVowel(word);
    return targets.some(
      (target) =>
        target.key === key &&
        (key.length > SHORT_KEY || target.vowel === vowel),
    );
  };
  const found: string[] = [];
  for (let start = 0; start < said.length; start++) {
    for (let length = 1; length <= LONGEST_RUN; length++) {
      const run = said.slice(start, start + length);
      if (run.length < length) break;
      // Words already spelled as the name need no hint, and a run that
      // starts or ends with filler is that filler plus a shorter run.
      if (run.every((word) => FILLER.has(word) || literal.has(word))) continue;
      if (FILLER.has(run[0] ?? "") || FILLER.has(run.at(-1) ?? "")) continue;
      if (literal.has(run.join(""))) continue;
      const phrase = run.join(" ");
      if (sounds(run.join("")) && !found.includes(phrase)) found.push(phrase);
    }
  }
  return found;
}
