import { sameBinding, type KeyBinding } from "./bindings";
import { formatBinding } from "./format";

// Common shifted pairs. Aliases for one physical key (⌘= and ⌘+) exist so
// the chord works on every layout; Settings shows that key once.
const SHIFTED: Readonly<Record<string, string>> = {
  "=": "+",
  "-": "_",
  "\\": "|",
  "/": "?",
  ",": "<",
  ".": ">",
  ";": ":",
  "'": '"',
  "[": "{",
  "]": "}",
  "`": "~",
};
const physicalKey = (key: string) =>
  Object.entries(SHIFTED).find((pair) => pair.includes(key))?.[0];
/** The same physical key with the same other modifiers, whatever Shift types on this layout. */
export const sameKeyOnLayout = (a: KeyBinding, b: KeyBinding) =>
  !!a.mod === !!b.mod &&
  !!a.ctrl === !!b.ctrl &&
  !!a.alt === !!b.alt &&
  physicalKey(a.key) !== undefined &&
  physicalKey(a.key) === physicalKey(b.key);
/** A searched chord finds what the dispatcher would match, and the layout's shifted alias. */
export const sameChord = (a: KeyBinding, b: KeyBinding) =>
  sameBinding(a, b) || sameKeyOnLayout(a, b);

type Modifier = "mod" | "control" | "alt" | "shift";
// Control is a modifier of its own on Apple platforms and `mod` elsewhere.
const MODIFIERS: Readonly<Record<string, Modifier>> = {
  "⌘": "mod",
  cmd: "mod",
  command: "mod",
  meta: "mod",
  mod: "mod",
  "⌃": "control",
  ctrl: "control",
  control: "control",
  "⌥": "alt",
  alt: "alt",
  opt: "alt",
  option: "alt",
  "⇧": "shift",
  shift: "shift",
};
const KEYS: Readonly<Record<string, string>> = {
  space: " ",
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  arrowup: "ArrowUp",
  "↑": "ArrowUp",
  down: "ArrowDown",
  arrowdown: "ArrowDown",
  "↓": "ArrowDown",
  left: "ArrowLeft",
  arrowleft: "ArrowLeft",
  "←": "ArrowLeft",
  right: "ArrowRight",
  arrowright: "ArrowRight",
  "→": "ArrowRight",
};
const GLYPHS = "⌘⌃⌥⇧↑↓←→";
const TOKENS = new RegExp(`[${GLYPHS}]|[^\\s+${GLYPHS}]+|\\+`, "g");

/**
 * A chord as shown ("⇧⌘K", "Ctrl+Shift+K") or typed ("cmd k"), or undefined
 * when the text names no single key. `+` separates unless it is the key, as
 * in "⌘+" or "Ctrl++".
 */
export function parseChord(
  query: string,
  apple: boolean,
): KeyBinding | undefined {
  const tokens = query.trim().toLowerCase().match(TOKENS) ?? [];
  const chord: { key?: string } & Record<string, boolean | string> = {};
  for (const [index, token] of tokens.entries()) {
    const modifier = MODIFIERS[token];
    if (modifier) {
      chord[modifier === "control" ? (apple ? "ctrl" : "mod") : modifier] =
        true;
      continue;
    }
    const previous = tokens[index - 1];
    if (
      token === "+" &&
      (index < tokens.length - 1 ||
        (previous !== undefined &&
          previous !== "+" &&
          !GLYPHS.includes(previous)))
    )
      continue;
    const key = Object.hasOwn(KEYS, token)
      ? KEYS[token]
      : [...token].length === 1 || /^f\d{1,2}$/.test(token)
        ? token
        : undefined;
    if (!key || chord.key !== undefined) return undefined;
    chord.key = key;
  }
  return chord.key === undefined ? undefined : (chord as KeyBinding);
}

/** One Settings row, prepared once so filtering only compares strings. */
export type SearchEntry = Readonly<{
  text: string;
  shown: string;
  chords: readonly KeyBinding[];
}>;
export const searchEntry = (
  title: string,
  group: string,
  chords: readonly KeyBinding[],
  apple: boolean,
): SearchEntry => ({
  text: `${title}\n${group}`.toLowerCase(),
  // One chord per line, so a query cannot match across two of them.
  shown: chords
    .map((chord) => formatBinding(chord, apple).text.toLowerCase())
    .join("\n"),
  chords,
});

export type ShortcutSearch =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "keys"; chord: KeyBinding }>;

/**
 * Text finds names, groups and chords; a text that is a whole chord matches
 * chords exactly, so "⌘K" does not also find ⇧⌘K. Recorded keys find chords only.
 */
export function shortcutFilter(
  search: ShortcutSearch,
  apple: boolean,
): Readonly<{
  chord: KeyBinding | undefined;
  matches: (entry: SearchEntry) => boolean;
}> {
  if (search.kind === "keys")
    return {
      chord: search.chord,
      matches: (entry) => entry.chords.some((c) => sameChord(c, search.chord)),
    };
  const text = search.text.trim().toLowerCase();
  const chord = parseChord(text, apple);
  const compact = text.replace(/\s+/g, "");
  return {
    chord,
    matches: (entry) =>
      entry.text.includes(text) ||
      (chord
        ? entry.chords.some((c) => sameChord(c, chord))
        : entry.shown.includes(compact)),
  };
}
