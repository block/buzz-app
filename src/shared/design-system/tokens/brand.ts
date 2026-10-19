/** Palette metadata for Appearance references and proposed plugin artwork. */
export const BRAND_SHADES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
/** Canonical Appearance order; re-exported by shared/theme/accent.ts. */
export const ACCENTS = [
  "chartreuse",
  "flame",
  "magenta",
  "iris",
  "cobalt",
  "jade",
] as const;
/** Proposed cross-color pairs preserve plugin artwork direction independently
 * of the existing Appearance choices above. */
export const BRAND_GRADIENTS = [
  {
    name: "Communication",
    category: "communication",
    from: "cyan",
    to: "blue",
    fromHue: 220,
    toHue: 255,
  },
  {
    name: "Agents",
    category: "agents",
    from: "violet",
    to: "indigo",
    fromHue: 295,
    toHue: 260,
  },
  {
    name: "Agent tools",
    category: "agent-tools",
    from: "fuchsia",
    to: "purple",
    fromHue: 335,
    toHue: 300,
  },
  {
    name: "Developer tools & integrations",
    category: "developer-tools-and-integrations",
    from: "coral",
    to: "pink",
    fromHue: 375,
    toHue: 340,
  },
  {
    name: "People & communities",
    category: "people-and-communities",
    from: "scarlet",
    to: "orange",
    fromHue: 380,
    toHue: 415,
  },
  {
    name: "Productivity",
    category: "productivity",
    from: "orange",
    to: "amber",
    fromHue: 420,
    toHue: 455,
  },
] as const;
