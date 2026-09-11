import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

test("both browser shards prepare the locked native fixture before Playwright", () => {
  const workflow = read(".github/workflows/ci.yml");
  const browser = workflow.match(
    /^ {2}browser:\n([\s\S]*?)(?=^ {2}\w+:|$(?![\s\S]))/m,
  )?.[1];
  assert.ok(browser, "browser job must exist");
  assert.match(browser, /shard: \[1, 2\]/);
  const preparation = browser.indexOf(
    "run: cargo build --locked -p buzzodz-plugins --example fixture-bridge",
  );
  const journey = browser.indexOf("run: pnpm test:browser:ci");
  assert.ok(
    preparation >= 0 && journey > preparation,
    "native fixture must build before the browser journeys",
  );
  // Setup must run on misses too, not merely when a cache is present.
  const step = browser.slice(
    browser.lastIndexOf("- name:", preparation),
    preparation,
  );
  assert.doesNotMatch(step, /\bif:/);
  assert.doesNotMatch(step, /continue-on-error/);
});

test("Hermit cache keys distinguish jobs that provision different tools", () => {
  const setup = read(".github/actions/setup/action.yml");
  assert.match(setup, /key: hermit-.*\$\{\{ github\.job \}\}/);
});
