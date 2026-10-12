import assert from "node:assert/strict";
import test from "node:test";
import {
  classify,
  hunkRanges,
  listBrowser,
  repeatableLines,
  selectTests,
  testBodies,
} from "../../scripts/flake-check.mjs";

test("classification follows the Vitest include globs and the Playwright spec directory", () => {
  for (const file of [
    "src/shared/theme/service.test.ts",
    "src/App.test.tsx",
    "src/plugins/x/y.test.mjs",
    "browser-host/runtime.test.mjs",
    "scripts/ci-test-report.test.ts",
    "scripts/nested/tool.test.mjs",
    "tests/fixtures/design-system/tokens.test.tsx",
  ])
    assert.equal(classify(file), "vitest", file);
  assert.equal(classify("tests/browser/layout.spec.mjs"), "browser");
  for (const file of [
    "src/shared/theme/service.ts",
    "src/shared/theme/service.spec.ts",
    "scripts/flake-check.mjs",
    "tests/integration/flake-check.test.mjs",
    "tests/browser/fixtures/helper.spec.mjs",
    "tests/browser/layout.spec.ts",
    "crates/foo/src/lib.rs",
    // Selections are shell-split downstream; refuse unusual names.
    "src/odd name.test.ts",
    "src/$(id).test.ts",
  ])
    assert.equal(classify(file), undefined, file);
});

test("-U0 hunks map to new-side ranges, with deletions attached to the preceding line", () => {
  const diff = [
    "diff --git a/x.test.ts b/x.test.ts",
    "--- a/x.test.ts",
    "+++ b/x.test.ts",
    "@@ -1 +1 @@",
    '-import { it } from "vitest";',
    '+import { expect, it } from "vitest";',
    "@@ -12,0 +13,3 @@ it('a', () => {",
    "+  const x = 1;",
    "+  const y = 2;",
    "+  expect(x).toBe(y - 1);",
    "@@ -30,2 +33,0 @@ it('b', () => {",
    "-  removed();",
    "-  alsoRemoved();",
    "@@ -1,3 +0,0 @@",
    "-gone",
    "",
  ].join("\n");
  assert.deepEqual(hunkRanges(diff), [
    { start: 1, end: 1 },
    { start: 13, end: 15 },
    { start: 33, end: 33 },
    { start: 0, end: 0 },
  ]);
  assert.deepEqual(hunkRanges(""), []);
});

test("test bodies span the listed test's call; groups, hooks and helpers are outside", () => {
  const source = [
    'import { afterAll, beforeEach, describe, expect, it } from "vitest";',
    "const shared = 1;",
    "function mount(props: { x?: number } = {}) {",
    "  return <div>{props.x ?? shared}</div>;",
    "}",
    'it("first", () => {',
    "  expect(mount()).toMatch(/a\\/b/);",
    "});",
    "function helper() {",
    '  return ")" + shared;',
    "}",
    'describe("group", () => {',
    "  beforeEach(() => {",
    "    helper();",
    "  });",
    "  it.each([",
    "    [1],",
    "    [2],",
    '  ])("case %s", (n) => {',
    "    expect(n).toBe(n);",
    "  });",
    '  it.skip("later", async () => {',
    "    await Promise.resolve();",
    "  });",
    "});",
    "afterAll(() => {",
    "  helper();",
    "});",
    "",
  ].join("\n");
  // Vitest lists the `it.each` cases at the second parenthesis (line 19).
  const listed = [19, 19, 22, 6];
  const bodies = testBodies(source, "tsx", listed);
  assert.deepEqual(bodies, [
    { start: 6, end: 8, line: 6 },
    { start: 16, end: 21, line: 19 },
    { start: 22, end: 24, line: 22 },
  ]);
  const select = (ranges) => selectTests(ranges, bodies);
  // Inside a body, including its closing line, selects only that test.
  assert.deepEqual(select([{ start: 7, end: 7 }]), { lines: [6] });
  assert.deepEqual(select([{ start: 21, end: 21 }]), { lines: [19] });
  assert.deepEqual(select([{ start: 23, end: 24 }]), { lines: [22] });
  // A helper between tests, a hook inside the group, and a hook after the
  // last test are shared code.
  for (const range of [
    { start: 10, end: 10 },
    { start: 14, end: 14 },
    { start: 27, end: 27 },
    { start: 2, end: 2 },
  ])
    assert.deepEqual(select([range]), {
      whole: true,
      reason: "shared code changed",
    });
  // A test the runner lists outside any `test`/`it` call has no body.
  assert.deepEqual(testBodies(source, "tsx", [10]), []);
  // Playwright: `test.describe` is a group, `test.beforeEach` a hook.
  const spec = [
    'import { test } from "@playwright/test";',
    'test.describe("suite", () => {',
    "  test.beforeEach(async ({ page }) => {",
    '    await page.goto("/");',
    "  });",
    '  test("journey", { tag: ["@local-webkit"] }, async ({ page }) => {',
    '    await page.click("text=Go");',
    "  });",
    "});",
    "",
  ].join("\n");
  assert.deepEqual(testBodies(spec, "js", [6]), [
    { start: 6, end: 8, line: 6 },
  ]);
});

test("hunks inside tests select those tests; shared code, new or unlisted files select the whole file", () => {
  const bodies = [
    { start: 10, end: 22, line: 10 },
    { start: 25, end: 37, line: 25 },
    { start: 38, end: 52, line: 40 },
  ];
  // Edit inside one test, including its first and last lines.
  assert.deepEqual(selectTests([{ start: 12, end: 14 }], bodies), {
    lines: [10],
  });
  assert.deepEqual(selectTests([{ start: 10, end: 10 }], bodies), {
    lines: [10],
  });
  assert.deepEqual(selectTests([{ start: 22, end: 22 }], bodies), {
    lines: [10],
  });
  // A hunk across two adjacent bodies selects both, by their listed lines.
  assert.deepEqual(selectTests([{ start: 36, end: 39 }], bodies), {
    lines: [25, 40],
  });
  // A hunk that also covers the gap between tests, or lines after the last
  // test, touches shared code.
  assert.deepEqual(selectTests([{ start: 22, end: 25 }], bodies), {
    whole: true,
    reason: "shared code changed",
  });
  assert.deepEqual(selectTests([{ start: 52, end: 53 }], bodies), {
    whole: true,
    reason: "shared code changed",
  });
  assert.deepEqual(selectTests([{ start: 400, end: 405 }], bodies), {
    whole: true,
    reason: "shared code changed",
  });
  // Several hunks accumulate distinct tests in file order.
  assert.deepEqual(
    selectTests(
      [
        { start: 41, end: 41 },
        { start: 11, end: 11 },
        { start: 12, end: 12 },
      ],
      bodies,
    ),
    { lines: [10, 40] },
  );
  // Deletion inside a test attaches to that test; deletion at the top of the
  // file (line 0) and edits before the first test fall back to the whole file.
  assert.deepEqual(selectTests([{ start: 30, end: 30 }], bodies), {
    lines: [25],
  });
  assert.deepEqual(selectTests([{ start: 0, end: 0 }], bodies), {
    whole: true,
    reason: "shared code changed",
  });
  assert.deepEqual(
    selectTests(
      [
        { start: 12, end: 12 },
        { start: 3, end: 3 },
      ],
      bodies,
    ),
    { whole: true, reason: "shared code changed" },
  );
  assert.deepEqual(
    selectTests([{ start: 12, end: 12 }], bodies, { added: true }),
    {
      whole: true,
      reason: "new file",
    },
  );
  assert.deepEqual(selectTests([{ start: 12, end: 12 }], []), {
    whole: true,
    reason: "no tests listed",
  });
});

test("journeys tagged for special projects or platforms are never repeated", () => {
  assert.deepEqual(
    repeatableLines([
      { line: 10, tags: [] },
      { line: 20, tags: ["media-recorder"] },
      { line: 30, tags: ["local-webkit"] },
      { line: 40, tags: ["classic-scrollbars"] },
      { line: 50, tags: ["other"] },
    ]),
    [10, 50],
  );
});

test("measurement specs list no engine journeys, alone or beside functional specs", () => {
  const measurements = [
    "tests/browser/channel-opening.spec.mjs",
    "tests/browser/scroll.spec.mjs",
  ];
  assert.deepEqual(
    listBrowser(measurements),
    new Map(measurements.map((file) => [file, []])),
  );
  const mixed = listBrowser([
    "tests/browser/scroll.spec.mjs",
    "tests/browser/voice-notes.spec.mjs",
  ]);
  assert.deepEqual(mixed.get("tests/browser/scroll.spec.mjs"), []);
  const journeys = mixed.get("tests/browser/voice-notes.spec.mjs");
  assert.ok(journeys.length > 1, "functional spec must list its journeys");
  assert.ok(
    journeys.some((spec) => spec.tags.includes("media-recorder")),
    "the listing keeps tagged journeys so they still own their line ranges",
  );
  assert.ok(repeatableLines(journeys).length < journeys.length);
});
