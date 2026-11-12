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
/** The distinct chords to show: each physical key once, in registration order. */
export const shownChords = (chords: readonly KeyBinding[]) =>
  chords.filter(
    (chord, index) =>
      !chords
        .slice(0, index)
        .some((earlier) => sameKeyOnLayout(earlier, chord)),
  );
/** Shift as the key reports it: a shifted glyph such as `+` implies it. */
const shifted = (chord: KeyBinding) =>
  !!chord.shift || Object.values(SHIFTED).includes(chord.key);
/**
 * A searched chord finds what the dispatcher would match, or the same
 * physical key typed another way on this layout (⌘⇧= for ⌘+), but never a
 * chord that differs by Shift (⌘⇧[ is not ⌘[).
 */
export const sameChord = (a: KeyBinding, b: KeyBinding) =>
  sameBinding(a, b) || (sameKeyOnLayout(a, b) && shifted(a) === shifted(b));

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

type Flag = "mod" | "ctrl" | "alt" | "shift";
type Parsed = Partial<Record<Flag, true>> & { key?: string };

/** Modifiers and at most one key, or undefined when the text is not keys. */
function parseKeys(query: string, apple: boolean): Parsed | undefined {
  const tokens = query.trim().toLowerCase().match(TOKENS) ?? [];
  const parsed: Parsed = {};
  for (const [index, token] of tokens.entries()) {
    const modifier = MODIFIERS[token];
    if (modifier) {
      parsed[modifier === "control" ? (apple ? "ctrl" : "mod") : modifier] =
        true;
      continue;
    }
    const previous = tokens[index - 1];
    // `+` separates unless it is the key, as in "⌘+" or "Ctrl++".
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
    if (!key || parsed.key !== undefined) return undefined;
    parsed.key = key;
  }
  return tokens.length ? parsed : undefined;
}

/**
 * A chord as shown ("⇧⌘K", "Ctrl+Shift+K") or typed ("cmd k"), or undefined
 * when the text names no single key.
 */
export function parseChord(
  query: string,
  apple: boolean,
): KeyBinding | undefined {
  const parsed = parseKeys(query, apple);
  return parsed?.key === undefined ? undefined : (parsed as KeyBinding);
}

/** A recorded key press: its chord, and the physical key that typed it. */
export type KeyPress = Readonly<{ chord: KeyBinding; code: string }>;

/** One Settings row, prepared once so filtering only compares strings. */
export type SearchEntry = Readonly<{
  text: string;
  /** The chords as the row shows them; aliases match only a whole chord. */
  shown: string;
  visible: readonly KeyBinding[];
  chords: readonly KeyBinding[];
  /** A row whose owner matches presses itself, as the message editor does. */
  presses?: ((press: KeyPress) => boolean) | undefined;
}>;
export const searchEntry = (
  title: string,
  group: string,
  chords: readonly KeyBinding[],
  apple: boolean,
  presses?: (press: KeyPress) => boolean,
): SearchEntry => ({
  text: `${title}\n${group}`.toLowerCase(),
  // One chord per line, so a query cannot match across two of them.
  shown: shownChords(chords)
    .map((chord) => formatBinding(chord, apple).text.toLowerCase())
    .join("\n"),
  visible: shownChords(chords),
  chords,
  presses,
});

export type ShortcutSearch =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "keys"; chord: KeyBinding; code: string }>;

/**
 * Text finds names, groups and chords. A whole chord matches chords exactly,
 * so "⌘K" does not also find ⇧⌘K; modifiers alone ("cmd shift") find the
 * shown chords that hold them. Recorded keys find chords only.
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
      matches: (entry) =>
        entry.chords.some((c) => sameChord(c, search.chord)) ||
        !!entry.presses?.(search),
    };
  const text = search.text.trim().toLowerCase();
  const keys = parseKeys(text, apple);
  const chord = keys?.key === undefined ? undefined : (keys as KeyBinding);
  const held = (["mod", "ctrl", "alt", "shift"] as const).filter(
    (flag) => keys?.[flag],
  );
  const compact = text.replace(/\s+/g, "");
  return {
    chord,
    matches: (entry) =>
      entry.text.includes(text) ||
      (chord
        ? entry.chords.some((c) => sameChord(c, chord))
        : keys
          ? entry.visible.some((c) => held.every((flag) => c[flag]))
          : entry.shown.includes(compact)),
  };
}
