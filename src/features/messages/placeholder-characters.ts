/** The characters protected-content placeholders are built from. A part reads
 * `start` (or `mention`), its nonce, `separator`, its index, then `end` (or
 * `mention`). None of them is Markdown syntax, and each ends a bare URL in the
 * text around it, as the protected part it holds does. */
export const placeholder = {
  start: "",
  separator: "",
  end: "",
  mention: "￼",
} as const;

/** Every placeholder character, for a regular expression character class. */
export const placeholderCharacters = Object.values(placeholder).join("");
