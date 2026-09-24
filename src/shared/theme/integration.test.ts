import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("legacy recipes do not depend on native scope support", () => {
  const css = readFileSync("src/shared/styles/globals.css", "utf8");
  expect(css).not.toMatch(/@scope\b/);
  expect(css).toContain("button:not(:where([data-buzz-ui], [data-buzz-ui] *))");
});
