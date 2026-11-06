/** Named, complete color sets. A theme owns the shell's neutrals, canvas and sidebar. */
export const THEMES = [
  "buzz",
  "relax",
  "utmost",
  "troupe",
  "cacophony",
  "cable",
  "baton",
  "howdy",
  "tundra",
] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "buzz";
export const THEME_KEY = "buzz-theme.v1";

type Mode = "light" | "dark";

export interface ThemeDefinition {
  readonly id: Theme;
  readonly label: string;
  readonly description: string;
  /** Which scope the frame (canvas, top bar and sidebar) renders in, per page mode. */
  readonly frame: Readonly<Record<Mode, Mode>>;
  /** Palette prefix of the family the `theme` accent resolves to. */
  readonly accentFamily: string;
  readonly accentName: string;
}

export const THEME_DEFINITIONS: Readonly<Record<Theme, ThemeDefinition>> = {
  buzz: {
    id: "buzz",
    label: "Buzz",
    description: "Neutral grays that let your accent color stand out.",
    frame: { light: "light", dark: "dark" },
    accentFamily: "citrus",
    accentName: "Citrus",
  },
  relax: {
    id: "relax",
    label: "Relax",
    description: "Deep plum frame around a bright, open workspace.",
    frame: { light: "dark", dark: "dark" },
    accentFamily: "relax",
    accentName: "Plum",
  },
  utmost: {
    id: "utmost",
    label: "Utmost",
    description:
      "A steady navy sidebar, a crisp white page and a confident blue.",
    frame: { light: "dark", dark: "dark" },
    accentFamily: "cobalt",
    accentName: "Cobalt",
  },
  troupe: {
    id: "troupe",
    label: "Troupe",
    description: "Soft periwinkle on calm, even grays.",
    frame: { light: "light", dark: "dark" },
    accentFamily: "troupe",
    accentName: "Periwinkle",
  },
  cacophony: {
    id: "cacophony",
    label: "Cacophony",
    description: "Stacked slate panels with an electric violet glow.",
    frame: { light: "light", dark: "dark" },
    accentFamily: "iris",
    accentName: "Iris",
  },
  cable: {
    id: "cable",
    label: "Cable",
    description: "Airy sky blue with fresh green replies.",
    frame: { light: "light", dark: "dark" },
    accentFamily: "cable",
    accentName: "Sky",
  },
  baton: {
    id: "baton",
    label: "Baton",
    description:
      "Beige-box chrome and navy highlights. After dark, it glows green.",
    frame: { light: "light", dark: "dark" },
    accentFamily: "baton",
    accentName: "Baton",
  },
  howdy: {
    id: "howdy",
    label: "Howdy",
    description: "A warm paper page, teal accents and minty replies.",
    frame: { light: "light", dark: "dark" },
    accentFamily: "howdy",
    accentName: "Teal",
  },
  tundra: {
    id: "tundra",
    label: "Tundra",
    description:
      "Frosted gray sidebar, steel-blue highlights and a warm coral badge.",
    frame: { light: "light", dark: "dark" },
    accentFamily: "tundra",
    accentName: "Steel",
  },
};

export function parseTheme(value: unknown): Theme {
  return THEMES.includes(value as Theme) ? (value as Theme) : DEFAULT_THEME;
}

/**
 * The scope that differs from the page. A dark frame over a light page needs its own
 * scope; a dark page already renders its frame dark.
 */
export function frameScope(theme: Theme, mode: Mode): "dark" | undefined {
  return mode === "light" && THEME_DEFINITIONS[theme].frame.light === "dark"
    ? "dark"
    : undefined;
}
