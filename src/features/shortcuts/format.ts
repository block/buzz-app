import type { KeyBinding } from "./bindings";

/** The dispatcher's platform test: `mod` is Command here and Control elsewhere. */
export const isApplePlatform = (platform: string) =>
  /Mac|iPhone|iPad/.test(platform);

export type FormattedBinding = Readonly<{
  /** One entry per key chip, e.g. ["⇧", "⌘", "K"] or ["Ctrl", "Shift", "K"]. */
  parts: readonly string[];
  /** Compact display text, e.g. "⇧⌘K" or "Ctrl+Shift+K". */
  text: string;
  /** Plain words for assistive technology, e.g. "Shift Command K". */
  label: string;
}>;

type Words = readonly [display: string, spoken: string];
const SPECIAL_KEYS: Readonly<Record<string, Words>> = {
  " ": ["Space", "Space"],
  enter: ["Enter", "Enter"],
  escape: ["Escape", "Escape"],
  tab: ["Tab", "Tab"],
  backspace: ["Backspace", "Backspace"],
  delete: ["Delete", "Delete"],
  home: ["Home", "Home"],
  end: ["End", "End"],
  pageup: ["PageUp", "Page Up"],
  pagedown: ["PageDown", "Page Down"],
  arrowup: ["↑", "Up Arrow"],
  arrowdown: ["↓", "Down Arrow"],
  arrowleft: ["←", "Left Arrow"],
  arrowright: ["→", "Right Arrow"],
};
// Apple follows the platform convention Control, Option, Shift, Command.
const APPLE_MODIFIERS: Readonly<Record<"alt" | "shift" | "mod", Words>> = {
  alt: ["⌥", "Option"],
  shift: ["⇧", "Shift"],
  mod: ["⌘", "Command"],
};
const OTHER_MODIFIERS: Readonly<Record<"mod" | "alt" | "shift", Words>> = {
  mod: ["Ctrl", "Control"],
  alt: ["Alt", "Alt"],
  shift: ["Shift", "Shift"],
};

/** One formatter for every chord in the UI, so hints cannot drift from the dispatcher. */
export function formatBinding(
  binding: KeyBinding,
  apple: boolean,
): FormattedBinding {
  const normalized = binding.key.toLowerCase();
  const special = Object.hasOwn(SPECIAL_KEYS, normalized)
    ? SPECIAL_KEYS[normalized]
    : undefined;
  const key: Words = special ?? [
    binding.key.length === 1 ? binding.key.toUpperCase() : binding.key,
    binding.key.length === 1 ? binding.key.toUpperCase() : binding.key,
  ];
  const table = apple ? APPLE_MODIFIERS : OTHER_MODIFIERS;
  const modifiers = (Object.keys(table) as (keyof typeof table)[])
    .filter((flag) => binding[flag])
    .map((flag) => table[flag]);
  const parts = [...modifiers, key];
  return Object.freeze({
    parts: Object.freeze(parts.map(([display]) => display)),
    text: parts.map(([display]) => display).join(apple ? "" : "+"),
    label: parts.map(([, spoken]) => spoken).join(" "),
  });
}
