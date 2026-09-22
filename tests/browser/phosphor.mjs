import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { expect } from "@playwright/test";

const require = createRequire(import.meta.url);
const core = pathToFileURL(require.resolve("@phosphor-icons/core"));

// Expected artwork comes from the pinned upstream asset, not the app's mapping.
// This detects empty/wrong glyphs even when their size and viewBox are identical.
export async function expectPhosphor(locator, name, weight = "regular") {
  const filename =
    weight === "regular" ? `${name}.svg` : `${name}-${weight}.svg`;
  const svg = readFileSync(
    new URL(`../assets/${weight}/${filename}`, core),
    "utf8",
  );
  const paths = [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(
    (match) => match[1],
  );
  expect(paths.length).toBeGreaterThan(0);
  await expect(locator).toHaveCount(1);
  await expect(locator).toHaveAttribute("viewBox", "0 0 256 256");
  await expect(locator).toHaveAttribute("fill", "currentColor");
  await expect(locator.locator("path")).toHaveCount(paths.length);
  for (const [index, path] of paths.entries())
    await expect(locator.locator("path").nth(index)).toHaveAttribute("d", path);
}
