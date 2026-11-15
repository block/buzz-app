export const SKIN_TONE_SLOT = "buzz-skin-tone";

// Mart's skin indexes 1–6; 1 is the default yellow, 2–6 add a Fitzpatrick modifier.
const MODIFIERS = [
  "",
  "\u{1F3FB}",
  "\u{1F3FC}",
  "\u{1F3FD}",
  "\u{1F3FE}",
  "\u{1F3FF}",
];

/** The tone Mart saved (`emoji-mart.skin`), or undefined before anyone chose one. */
export function savedSkinTone(): number | undefined {
  try {
    const saved = localStorage.getItem("emoji-mart.skin");
    if (saved === null) return undefined;
    const tone = Number(JSON.parse(saved));
    return Number.isInteger(tone) && tone >= 1 && tone <= 6 ? tone : undefined;
  } catch {
    return undefined;
  }
}

/** The default tone, so non-Mart surfaces match the picker. */
export const defaultSkinTone = () => savedSkinTone() ?? 1;

/** Nobody has chosen a tone yet, and storage can keep the one they choose. */
export function skinToneUnchosen(): boolean {
  try {
    return localStorage.getItem("emoji-mart.skin") === null;
  } catch {
    return false;
  }
}

/** The call me hand in `tone`, the footer's skin-tone glyph. */
export const toneHand = (tone: number) =>
  `\u{1F919}${MODIFIERS[tone - 1] ?? ""}`;
