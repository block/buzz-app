import { expect, it } from "vitest";
import {
  apcaContrast,
  parseHex,
  wcagRatio,
} from "../../../scripts/design-system/apca.mjs";

import { externalLabelStyle } from "./external-labels";

const modes = {
  light: {
    ink: "--external-label-light-ink",
    fill: "--external-label-light-fill",
    border: "--external-label-light-border",
  },
  dark: {
    ink: "--external-label-dark-ink",
    fill: "--external-label-dark-fill",
    border: "--external-label-dark-border",
  },
};

it("uses a neutral fallback for absent or invalid external label colors", () => {
  for (const value of [
    undefined,
    "",
    "#123456",
    "12345",
    "1234567",
    "gggggg",
    "transparent",
  ])
    expect(externalLabelStyle(value), String(value)).toBeUndefined();
  expect(externalLabelStyle("2ea44f")).toEqual(externalLabelStyle("2EA44F"));
});

it("keeps external label ink/fill pairs readable across a structured RGB grid", () => {
  const channels = Array.from({ length: 16 }, (_, index) => index * 17);
  const minima = Object.fromEntries(
    Object.keys(modes).map((mode) => [
      mode,
      { wcag: { value: Infinity }, apca: { value: Infinity } },
    ]),
  );

  for (const red of channels)
    for (const green of channels)
      for (const blue of channels) {
        const sourceHex = [red, green, blue]
          .map((channel) => channel.toString(16).padStart(2, "0"))
          .join("");
        const style = externalLabelStyle(sourceHex);
        for (const [mode, names] of Object.entries(modes)) {
          const ink = style?.[names.ink];
          const fill = style?.[names.fill];
          const border = style?.[names.border];
          for (const value of [ink, fill, border]) {
            expect(value).toMatch(/^#[0-9a-f]{6}$/);
            expect(parseHex(value)).toHaveLength(3);
          }
          const wcag = wcagRatio(ink, fill);
          const apca = Math.abs(apcaContrast(ink, fill));
          const minimum = minima[mode];
          if (wcag < minimum.wcag.value)
            minimum.wcag = { value: wcag, source: sourceHex, ink, fill };
          if (apca < minimum.apca.value)
            minimum.apca = { value: apca, source: sourceHex, ink, fill };
        }
      }

  for (const [mode, minimum] of Object.entries(minima)) {
    expect(
      minimum.wcag.value,
      `${mode} WCAG: ${JSON.stringify(minimum.wcag)}`,
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      minimum.apca.value,
      `${mode} APCA: ${JSON.stringify(minimum.apca)}`,
    ).toBeGreaterThanOrEqual(45);
  }
  console.info(`External-label contrast minima: ${JSON.stringify(minima)}`);
});
