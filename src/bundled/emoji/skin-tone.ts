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

/** The default tone Mart saves (`emoji-mart.skin`), so non-Mart surfaces match it. */
export function defaultSkinTone(): number {
  try {
    const tone = Number(
      JSON.parse(localStorage.getItem("emoji-mart.skin") ?? "1"),
    );
    return Number.isInteger(tone) && tone >= 1 && tone <= 6 ? tone : 1;
  } catch {
    return 1;
  }
}

/** The call me hand in `tone`, the footer's skin-tone glyph. */
export const toneHand = (tone: number) =>
  `\u{1F919}${MODIFIERS[tone - 1] ?? ""}`;
