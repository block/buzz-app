import { MAX_FONT_SCALE, MIN_FONT_SCALE, parseFontScale } from "./service";

/**
 * The appearance the main window has applied to its document (`createAppearance`
 * writes `data-color-mode`, `data-accent`, `data-color-level` and the text
 * scale on `<html>`), as a companion window can reproduce it. Appearance is a
 * property of the person, so every window of the app shows the same one.
 */
export type DocumentAppearance = Readonly<{
  colorMode: "light" | "dark";
  accent?: string | undefined;
  colorLevel?: string | undefined;
  fontScale?: number | undefined;
}>;
/** `<html>` attributes whose change means the appearance changed. */
export const APPEARANCE_ATTRIBUTES = [
  "class",
  "data-color-mode",
  "data-accent",
  "data-color-level",
  "style",
];
const TOKEN = /^[a-z][a-z0-9-]{0,31}$/;
const token = (value: string | undefined) =>
  value && TOKEN.test(value) ? value : undefined;

export function readDocumentAppearance(
  root: HTMLElement = document.documentElement,
): DocumentAppearance {
  const scale = parseFontScale(
    Number.parseFloat(root.style.getPropertyValue("--buzz-text-scale")),
  );
  return {
    colorMode:
      root.dataset.colorMode === "dark" || root.classList.contains("dark")
        ? "dark"
        : "light",
    accent: token(root.dataset.accent),
    colorLevel: token(root.dataset.colorLevel),
    ...(scale === 1 ? {} : { fontScale: scale }),
  };
}

/** Apply a projected appearance to this window's document. */
export function applyDocumentAppearance(
  appearance: DocumentAppearance,
  root: HTMLElement = document.documentElement,
) {
  const dark = appearance.colorMode === "dark";
  root.classList.toggle("dark", dark);
  root.dataset.colorMode = dark ? "dark" : "light";
  const accent = token(appearance.accent);
  if (accent) root.dataset.accent = accent;
  else delete root.dataset.accent;
  const level = token(appearance.colorLevel);
  if (level) root.dataset.colorLevel = level;
  else delete root.dataset.colorLevel;
  const scale = appearance.fontScale;
  if (
    typeof scale === "number" &&
    Number.isFinite(scale) &&
    scale >= MIN_FONT_SCALE &&
    scale <= MAX_FONT_SCALE
  )
    root.style.setProperty("--buzz-text-scale", String(scale));
  else root.style.removeProperty("--buzz-text-scale");
}
