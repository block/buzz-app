import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const { scripts } = JSON.parse(read("package.json"));

test("the design viewer and scan retain their design command entry points", () => {
  for (const command of [
    "dev",
    "build",
    "preview",
    "typecheck",
    "check",
    "census",
    "test",
    "test:browser",
  ])
    assert.ok(scripts[`design:${command}`], `Missing design:${command}`);
  for (const command of ["design:typecheck", "design:check"])
    assert.ok(scripts.check.split(" && ").includes(`pnpm ${command}`));
  assert.match(read("justfile"), /^ {4}pnpm design:test:browser$/m);
  assert.match(
    scripts["design:test:browser"],
    /pnpm design:build && playwright test --config tests\/fixtures\/design-system\/playwright\.config\.ts/,
  );
  assert.match(
    read("tests/fixtures/design-system/playwright.config.ts"),
    /command: "bin\/pnpm design:preview"/,
  );
});
