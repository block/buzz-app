import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { BRAND_FAMILIES, BRAND_GRADIENTS } from "./brand";

const css = readFileSync(
  new URL("../styles/tokens.css", import.meta.url),
  "utf8",
);
function rgb(l: number, c: number, h: number) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const x = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const y = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const z = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z,
    -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z,
    -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z,
  ] as const;
}

it("gives six distinct identities comparable contrast across the full gradient", () => {
  expect(new Set(BRAND_GRADIENTS.map(({ family }) => family))).toEqual(
    new Set(BRAND_FAMILIES.map(({ id }) => id)),
  );
  for (const family of BRAND_FAMILIES) {
    const readStop = (stop: string) => {
      const match = css.match(
        new RegExp(
          `--art-${family.id}-${stop}: oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+)\\)`,
        ),
      );
      if (!match) throw new Error(`Missing ${family.id} ${stop}`);
      return [
        Number(match[1]) / 100,
        Number(match[2]),
        Number(match[3]),
      ] as const;
    };
    const start = readStop("start");
    const end = readStop("end");
    for (let index = 0; index <= 20; index++) {
      const t = index / 20;
      const l = start[0] + (end[0] - start[0]) * t;
      const c = start[1] + (end[1] - start[1]) * t;
      const h = start[2] + (end[2] - start[2]) * t;
      const channels = rgb(l, c, h);
      for (const channel of channels) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
      const luminance =
        channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      expect(Math.abs(luminance - 0.18)).toBeLessThan(0.002);
      expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
      expect((luminance + 0.05) / 0.05).toBeGreaterThanOrEqual(4.5);
    }
  }
  const hues = BRAND_FAMILIES.map(({ hue }) => hue).sort((a, b) => a - b);
  for (const a of hues)
    for (const b of hues) {
      if (a !== b)
        expect(
          Math.min(Math.abs(a - b), 360 - Math.abs(a - b)),
        ).toBeGreaterThan(16);
    }
});
