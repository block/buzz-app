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
    start: "cyan-9",
    end: "blue-9",
    compromise:
      "Cyan to blue uses existing solid-color steps for a visible cool hue transition.",
  },
  {
    name: "Agents",
    category: "agents",
    start: "blue-9",
    end: "purple-9",
    compromise:
      "Blue 9 is lighter at the top; purple 9 approximates violet at the bottom in both themes.",
  },
  {
    name: "Agent tools",
    category: "agent-tools",
    start: "red-9",
    end: "purple-9",
    compromise:
      "Red approximates the missing fuchsia endpoint while preserving a distinct transition into purple.",
  },
  {
    name: "Developer tools & integrations",
    category: "developer-tools-and-integrations",
    start: "orange-9",
    end: "purple-9",
    compromise:
      "Orange approximates coral and purple approximates pink; the broader sweep preserves visible color variation.",
  },
  {
    name: "People & communities",
    category: "people-and-communities",
    start: "red-9",
    end: "orange-9",
    compromise: "Red approximates scarlet and transitions into orange.",
  },
  {
    name: "Productivity",
    category: "productivity",
    start: "amber-9",
    end: "green-9",
    compromise:
      "Amber to green preserves the original warm-to-yellow-green intent using existing families.",
  },
] as const;
