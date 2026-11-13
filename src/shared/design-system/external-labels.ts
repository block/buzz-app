import type { CSSProperties } from "react";

/**
 * Style validated external label colors without treating them as controls or
 * status roles. Undefined selects the caller's neutral semantic fallback.
 * Both modes use opaque, paired ink/fill/border values instead of source-color
 * backgrounds and opacity. Contrast evidence lives in the adjacent tests.
 */
export function externalLabelStyle(
  source: string | undefined,
): CSSProperties | undefined {
  if (!source || !/^[0-9a-f]{6}$/i.test(source)) return undefined;
  const channels = [0, 2, 4].map(
    (offset) => Number.parseInt(source.slice(offset, offset + 2), 16) / 255,
  );
  const [hue, saturation] = hslFromRgb(channels);
  const lightSaturation = Math.min(saturation, 0.45);
  const darkSaturation = Math.min(saturation, 0.55);

  // Conservative lightness bounds retain hue while separating text from its
  // paired fill. These are intentionally not source lightness or text colors.
  return {
    "--external-label-light-ink": hexFromHsl(hue, saturation, 0.2),
    "--external-label-light-fill": hexFromHsl(hue, lightSaturation, 0.93),
    "--external-label-light-border": hexFromHsl(hue, lightSaturation, 0.75),
    "--external-label-dark-ink": hexFromHsl(hue, saturation, 0.82),
    "--external-label-dark-fill": hexFromHsl(hue, darkSaturation, 0.16),
    "--external-label-dark-border": hexFromHsl(hue, darkSaturation, 0.38),
  } as CSSProperties;
}

/** Convert a validated RGB triplet to hue in degrees and HSL saturation. */
function hslFromRgb(channels: number[]): [number, number] {
  const [red = 0, green = 0, blue = 0] = channels;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const range = maximum - minimum;
  if (range === 0) return [0, 0];
  const lightness = (maximum + minimum) / 2;
  const hue =
    maximum === red
      ? ((green - blue) / range) % 6
      : maximum === green
        ? (blue - red) / range + 2
        : (red - green) / range + 4;
  return [(hue * 60 + 360) % 360, range / (1 - Math.abs(2 * lightness - 1))];
}

function hexFromHsl(
  hue: number,
  saturation: number,
  lightness: number,
): string {
  const amplitude = saturation * Math.min(lightness, 1 - lightness);
  const channel = (sector: number) => {
    const offset = (sector + hue / 30) % 12;
    const value =
      lightness - amplitude * Math.max(-1, Math.min(offset - 3, 9 - offset, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
