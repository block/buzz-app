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
/** Proposed artwork mapping uses existing theme-aware palette families independently
 * of the existing Appearance choices above. */
export const BRAND_GRADIENTS = [
  {
    name: "Communication",
    category: "communication",
    start: "cyan-11",
    end: "blue-11",
    compromise:
      "Cyan and blue use existing families; their different step-11 theme values change the balance.",
  },
  {
    name: "Agents",
    category: "agents",
    start: "purple-9",
    end: "blue-11",
    compromise:
      "Violet maps to purple; indigo maps to blue. Exact source hues are unavailable.",
  },
  {
    name: "Agent tools",
    category: "agent-tools",
    start: "purple-9",
    end: "purple-9",
    compromise:
      "Fuchsia and purple both map to purple 9: this category becomes a flat fill.",
  },
  {
    name: "Developer tools & integrations",
    category: "developer-tools-and-integrations",
    start: "red-10",
    end: "purple-9",
    compromise:
      "Coral maps to red; pink maps to purple. The transition is red to purple.",
  },
  {
    name: "People & communities",
    category: "people-and-communities",
    start: "red-10",
    end: "orange-11",
    compromise: "Scarlet maps to red; orange uses the existing orange family.",
  },
  {
    name: "Productivity",
    category: "productivity",
    start: "orange-11",
    end: "amber-11",
    compromise:
      "Both original warm hues use existing orange and amber; no new yellow-green family.",
  },
] as const;
