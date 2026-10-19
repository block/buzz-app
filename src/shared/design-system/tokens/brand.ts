/** Existing accent identities, reused by plugin artwork. */
export const BRAND_SHADES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export const BRAND_FAMILIES = [
  { id: "cobalt", hue: 266.6948 },
  { id: "iris", hue: 284.502 },
  { id: "magenta", hue: 355.6028 },
  { id: "flame", hue: 34.6181 },
  { id: "jade", hue: 169.9836 },
  { id: "chartreuse", hue: 109.5919 },
] as const;
export const BRAND_GRADIENTS = [
  { name: "Communication", category: "communication", family: "cobalt" },
  { name: "Agents", category: "agents", family: "iris" },
  { name: "Agent tools", category: "agent-tools", family: "magenta" },
  {
    name: "Developer tools & integrations",
    category: "developer-tools-and-integrations",
    family: "flame",
  },
  {
    name: "People & communities",
    category: "people-and-communities",
    family: "jade",
  },
  { name: "Productivity", category: "productivity", family: "chartreuse" },
] as const;
