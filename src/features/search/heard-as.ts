// What a spoken request said that names something: the words that sound
// like its name (`soundsLike`), the words that spell it, and the ways people
// say a name that its spelling hides: "relay perf" for #relay-perf, "drone
// oh one" for drone01. Voice actions show these to the decision provider
// for each closed-set option, so a find question sees the link instead of
// having to hear it from spelling.
import { nameWords, soundKey, soundsLike } from "./sounds-like";

const DIGIT_WORDS: readonly (readonly string[])[] = [
  ["zero", "oh"],
  ["one"],
  ["two"],
  ["three"],
  ["four"],
  ["five"],
  ["six"],
  ["seven"],
  ["eight"],
  ["nine"],
];
const NUMBER_WORDS =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(
    " ",
  );
/** Keeps a name with many numbers from growing past a few forms. */
const MAX_FORMS = 8;
/** A sound key at least this long may match as a prefix ("purr" for perf). */
const PREFIX_KEY = 2;

/** Words, split also between letters and digits: drone01 -> drone, 01. */
const tokens = (text: string) =>
  nameWords(text)
    .flatMap((word) =>
      word.split(/(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/),
    )
    .map((word) => word.toLowerCase())
    .filter(Boolean);

/** How a number is said: digit by digit ("oh one"), or as its value ("one"). */
function sayNumber(digits: string): string[][] {
  const each = [...digits].reduce<string[][]>(
    (forms, digit) =>
      forms.flatMap((form) =>
        (DIGIT_WORDS[Number(digit)] ?? []).map((word) => [...form, word]),
      ),
    [[]],
  );
  const value = Number(digits);
  const whole = NUMBER_WORDS[value];
  return [
    [digits],
    ...(whole && (digits.length > 1 || value > 9) ? [[whole]] : []),
    ...each,
  ];
}

/** The ways a name's words are said aloud, each as lowercase words. */
export function spokenForms(name: string): string[][] {
  let forms: string[][] = [[]];
  for (const word of tokens(name)) {
    const options = /^[0-9]+$/.test(word) ? sayNumber(word) : [[word]];
    forms = forms
      .flatMap((form) => options.map((option) => [...form, ...option]))
      .slice(0, MAX_FORMS);
  }
  return forms.filter((form) => form.length);
}

const near = (said: string, word: string) => {
  const a = soundKey(said);
  const b = soundKey(word);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= PREFIX_KEY && long.startsWith(short);
};

/** What `spoken` said that names `name`: spelled, sounded, or said in one
 * of its spoken forms. A form of two or more words also matches when one
 * word is spelled the same and the others sound close ("relay purr"). Only
 * a whole name matches by spelling, so "buzz" names no `buzz-*` channel. A
 * name with a number is matched only by its spoken forms. */
export function heardAs(spoken: string, name: string): string[] {
  const said = tokens(spoken.replace(/'s\b/g, ""));
  const found = new Set<string>();
  for (const form of spokenForms(name)) {
    for (let start = 0; start + form.length <= said.length; start++) {
      const run = said.slice(start, start + form.length);
      const same = run.map((word, i) => word === form[i]);
      const matches =
        same.every(Boolean) ||
        (form.length > 1 &&
          same.some(Boolean) &&
          run.every((word, i) => same[i] || near(word, form[i] as string)));
      if (matches) found.add(run.join(" "));
    }
  }
  // `soundsLike` drops digits, so it hears drone00 in "drone oh one" as
  // well as drone01: a name with a number is matched by its spoken forms.
  if (!/[0-9]/.test(name))
    for (const phrase of soundsLike(spoken, name)) found.add(phrase);
  return [...found];
}
