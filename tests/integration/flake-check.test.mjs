import assert from "node:assert/strict";
import test from "node:test";
import {
  classify,
  hunkRanges,
  listBrowser,
  repeatableLines,
  selectTests,
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

test("hunks inside tests select those tests; shared code, new or unlisted files select the whole file", () => {
  const starts = [10, 25, 40];
  // Edit inside one test, including its last lines before the next test.
  assert.deepEqual(selectTests([{ start: 12, end: 14 }], starts), {
    lines: [10],
  });
  assert.deepEqual(selectTests([{ start: 24, end: 24 }], starts), {
    lines: [10],
  });
  // A hunk straddling two tests selects both; the last test owns the tail.
  assert.deepEqual(selectTests([{ start: 23, end: 26 }], starts), {
    lines: [10, 25],
  });
  assert.deepEqual(selectTests([{ start: 400, end: 405 }], starts), {
    lines: [40],
  });
  // Several hunks accumulate distinct tests in file order.
  assert.deepEqual(
    selectTests(
      [
        { start: 41, end: 41 },
        { start: 11, end: 11 },
        { start: 12, end: 12 },
      ],
      starts,
    ),
    { lines: [10, 40] },
  );
  // Deletion inside a test attaches to that test; deletion at the top of the
  // file (line 0) and edits to imports, helpers or hooks before the first test
  // fall back to the whole file.
  assert.deepEqual(selectTests([{ start: 30, end: 30 }], starts), {
    lines: [25],
  });
  assert.deepEqual(selectTests([{ start: 0, end: 0 }], starts), {
    whole: true,
    reason: "shared code changed",
  });
  assert.deepEqual(
    selectTests(
      [
        { start: 12, end: 12 },
        { start: 3, end: 3 },
      ],
      starts,
    ),
    { whole: true, reason: "shared code changed" },
  );
  assert.deepEqual(
    selectTests([{ start: 12, end: 12 }], starts, { added: true }),
    {
      whole: true,
      reason: "new file",
    },
  );
  assert.deepEqual(selectTests([{ start: 12, end: 12 }], []), {
    whole: true,
    reason: "no tests listed",
  });
  // Parameterised Vitest cases share a start line and select once.
  assert.deepEqual(selectTests([{ start: 10, end: 10 }], [10, 10, 10, 25]), {
    lines: [10],
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
