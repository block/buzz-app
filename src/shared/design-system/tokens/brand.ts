/** Decorative artwork palette. Fixed scales, not theme-aware semantic roles.
 * Source: plugin branding Settings.module.css, revision 834b8ea4b.
 * Each 500 stop preserves one exact OKLCH gradient endpoint, including its hue.
 * Other stops vary lightness and taper chroma within sRGB; review before adoption.
 */
export const BRAND_SHADES = [
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
] as const;
export const BRAND_FAMILIES = [
  { id: "cyan", hue: 220, chroma: 0.109 },
  { id: "blue", hue: 255, chroma: 0.14 },
  { id: "violet", hue: 295, chroma: 0.14 },
  { id: "indigo", hue: 260, chroma: 0.14 },
  { id: "fuchsia", hue: 335, chroma: 0.14 },
  { id: "purple", hue: 300, chroma: 0.14 },
  { id: "coral", hue: 375, chroma: 0.14 },
  { id: "pink", hue: 340, chroma: 0.14 },
  { id: "scarlet", hue: 380, chroma: 0.14 },
  { id: "orange", hue: 415, chroma: 0.14 },
  { id: "gold", hue: 420, chroma: 0.14 },
  { id: "lime", hue: 455, chroma: 0.123 },
] as const;

export const BRAND_GRADIENTS = [
  { name: "Communication", from: "cyan", to: "blue" },
  { name: "Agents", from: "violet", to: "indigo" },
  { name: "Agent tools", from: "fuchsia", to: "purple" },
  { name: "Developer tools & integrations", from: "coral", to: "pink" },
  { name: "People & communities", from: "scarlet", to: "orange" },
  { name: "Productivity", from: "gold", to: "lime" },
] as const;
