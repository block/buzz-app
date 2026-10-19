import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { BRAND_GRADIENTS } from "./brand";
import { ROLE_GROUPS } from "./registry";

const css = readFileSync(
  new URL("../styles/tokens.css", import.meta.url),
  "utf8",
);
const light = css.slice(0, css.indexOf(':root[data-color-mode="dark"]'));
const dark = css.slice(
  css.indexOf(':root[data-color-mode="dark"]'),
  css.indexOf("LAYER 1 — FAMILIES"),
);

it("maps all artwork endpoints to existing family steps in both themes", () => {
  expect(new Set(BRAND_GRADIENTS.map(({ category }) => category)).size).toBe(6);
  for (const gradient of BRAND_GRADIENTS) {
    for (const [part, palette] of [
      ["start", gradient.start],
      ["end", gradient.end],
    ]) {
      expect(`--${palette}`).toMatch(
        /^--(amber|blue|cyan|green|orange|purple|red)-(?:[1-9]|1[0-2])$/,
      );
      expect(css).toContain(
        `--art-plugin-${gradient.category}-${part}: var(--${palette});`,
      );
      for (const mode of [light, dark])
        expect(mode).toMatch(new RegExp(`--${palette}: #[a-f0-9]{6};`));
    }
    const pattern = new RegExp(
      `--art-plugin-${gradient.category}-gradient: linear-gradient\\([\\s\\S]*?var\\(--art-plugin-${gradient.category}-start\\),[\\s\\S]*?var\\(--art-plugin-${gradient.category}-end\\)[\\s\\S]*?\\);`,
    );
    expect(css).toMatch(pattern);
  }
});

it("registers all public artwork with palette ownership and flags the flat compromise", () => {
  const roles = ROLE_GROUPS.flatMap(({ roles }) => roles);
  for (const gradient of BRAND_GRADIENTS)
    for (const part of ["start", "end", "gradient"]) {
      expect(
        roles.find(
          ({ variable }) =>
            variable === `--art-plugin-${gradient.category}-${part}`,
        ),
      ).toMatchObject({ status: "proposed", owner: "Settings plugin catalog" });
    }
  const tools = BRAND_GRADIENTS.find(
    ({ category }) => category === "agent-tools",
  );
  expect(tools?.start).toBe(tools?.end);
  expect(tools?.compromise).toContain("flat");
  expect(css).not.toContain("PLUGIN ARTWORK PALETTE");
});

it("keeps Agents blue above violet with a lighter top in both themes", () => {
  expect(
    BRAND_GRADIENTS.find(({ category }) => category === "agents"),
  ).toMatchObject({ start: "blue-9", end: "purple-9" });
  const luminance = (hex: string) => {
    const channels = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)]
      .map((part) => parseInt(part, 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return channels.reduce(
      (sum, channel, index) =>
        sum + channel * ([0.2126, 0.7152, 0.0722][index] ?? 0),
      0,
    );
  };
  for (const mode of [light, dark]) {
    const value = (token: string) => {
      const match = mode.match(new RegExp(`--${token}: #([a-f0-9]{6});`));
      if (!match?.[1]) throw new Error(`Missing palette token ${token}`);
      return match[1];
    };
    expect(luminance(value("blue-9"))).toBeGreaterThan(
      luminance(value("purple-9")),
    );
  }
});
