import { expect, it } from "vitest";
import {
  laneMatches,
  pathMatches,
  validateRouting,
  type LaneRule,
  type PullFacts,
} from "./routing";
const facts: PullFacts = {
  repository: "example-org/project",
  pr: 1,
  title: "Fix authentication",
  labels: ["Security", "backend"],
  changedFiles: 2,
  paths: ["src/auth.ts", "src/ui/form.tsx"],
  head: "a".repeat(40),
  base: "b".repeat(40),
};
const rule = (
  field: LaneRule["field"],
  operator: LaneRule["operator"],
  value: string,
): LaneRule => ({ id: crypto.randomUUID(), field, operator, value });
it("routes title, exact labels, counts and glob paths with all/any semantics", () => {
  const rules = [
    rule("title", "contains", "AUTH"),
    rule("label", "has", "security"),
    rule("files", "at-least", "2"),
    rule("files", "at-most", "2"),
    rule("path", "matches", "src/**/*.tsx"),
  ];
  expect(laneMatches(validateRouting({ mode: "all", rules }), facts)).toBe(
    true,
  );
  const missing = rule("label", "has", "sec");
  expect(laneMatches({ mode: "all", rules: [...rules, missing] }, facts)).toBe(
    false,
  );
  expect(laneMatches({ mode: "any", rules: [...rules, missing] }, facts)).toBe(
    true,
  );
  expect(laneMatches(undefined, facts)).toBe(true);
  expect(laneMatches({ mode: "any", rules: [] }, facts)).toBe(true);
});
it("negative path means no changed file matches, not at least one differs", () => {
  expect(
    laneMatches(
      { mode: "all", rules: [rule("path", "not-matches", "src/*.ts")] },
      facts,
    ),
  ).toBe(false);
  expect(
    laneMatches(
      {
        mode: "all",
        rules: [
          rule("path", "not-matches", "docs/**"),
          rule("title", "not-contains", "feature"),
          rule("label", "not-has", "UI"),
        ],
      },
      facts,
    ),
  ).toBe(true);
});
it.each([
  ["**/*.tsx", "form.tsx", true],
  ["src/**", "src/auth.ts", true],
  ["src/*.tsx", "src/ui/form.tsx", false],
  ["src/**/*.tsx", "src/form.tsx", true],
  ["src/?.ts", "src/a.ts", true],
  ["src/?.ts", "src/ab.ts", false],
  ["SRC/**", "src/a.ts", false],
  ["src/[x].ts", "src/[x].ts", true],
])("matches %s against %s", (pattern, path, expected) =>
  expect(pathMatches(pattern, path)).toBe(expected),
);
it("rejects malformed and unsupported persisted rules", () => {
  for (const raw of [
    null,
    { mode: "no", rules: [] },
    { mode: "all", rules: Array(13).fill(rule("title", "contains", "a")) },
    ...[
      rule("files", "at-least", "-1"),
      rule("files", "at-most", "1.5"),
      rule("path", "matches", "../**"),
      rule("path", "matches", "/src/**"),
      rule("path", "matches", "s**"),
      rule("path", "matches", "[abc]"),
      rule("label", "contains", "foo"),
    ].map((item) => ({ mode: "all", rules: [item] })),
  ])
    expect(() => validateRouting(raw)).toThrow();
  const repeated = rule("title", "contains", "x");
  expect(() =>
    validateRouting({ mode: "all", rules: [repeated, repeated] }),
  ).toThrow();
});
