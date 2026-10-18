import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { BRAND_FAMILIES, BRAND_GRADIENTS, BRAND_SHADES } from "./brand";

it("preserves the gradient endpoints inside complete descending shade ranges", () => {
  const css = readFileSync(
    new URL("../styles/tokens.css", import.meta.url),
    "utf8",
  );
  for (const family of BRAND_FAMILIES) {
    let previousLightness = 100;
    for (const shade of BRAND_SHADES) {
      const match = css.match(
        new RegExp(
          `--brand-${family.id}-${shade}: oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+)\\)`,
        ),
      );
      expect(match, `${family.id} ${shade}`).not.toBeNull();
      if (!match) throw new Error(`Missing ${family.id} ${shade}`);
      const [, lightness, chroma, hue] = match;
      expect(Number(lightness)).toBeLessThan(previousLightness);
      previousLightness = Number(lightness);
      expect(Number(hue)).toBe(family.hue);
      if (shade === 500) {
        expect(Number(lightness)).toBe(60);
        expect(Number(chroma)).toBe(family.chroma);
      }
    }
  }
  expect(
    new Set(BRAND_GRADIENTS.flatMap(({ from, to }) => [from, to])),
  ).toEqual(new Set(BRAND_FAMILIES.map(({ id }) => id)));
});
