import { afterEach, expect, it, vi } from "vitest";
import {
  candidatesFor,
  parseRecommended,
  recommendedCandidates,
} from "./recommended";

// Synthetic candidates; real values come only from a packager's build.
const CODEX = {
  harness: "codex",
  model: "model-a",
  effort: "high",
  label: "Model A",
};
const GOOSE = {
  harness: "goose",
  provider: "provider-b",
  model: "model-b",
  effort: "high",
  label: "Model B",
};
const recommend = (...candidates: object[]) =>
  vi.stubEnv("VITE_BUZZ_RECOMMENDED_AGENT", JSON.stringify(candidates));
afterEach(() => vi.unstubAllEnvs());

it("has no recommendation when the build sets none", () => {
  vi.stubEnv("VITE_BUZZ_RECOMMENDED_AGENT", "");
  expect(recommendedCandidates()).toEqual([]);
  expect(candidatesFor("goose")).toEqual([]);
});

it("reads this build's candidates, in order, per harness", () => {
  recommend(GOOSE, CODEX, { ...GOOSE, model: "model-c", label: "Model C" });
  expect(recommendedCandidates().map(({ model }) => model)).toEqual([
    "model-b",
    "model-a",
    "model-c",
  ]);
  expect(candidatesFor("goose").map(({ model }) => model)).toEqual([
    "model-b",
    "model-c",
  ]);
  expect(candidatesFor("pi")).toEqual([]);
});

it("parses candidates in order, several per harness, and rejects anything else", () => {
  const backup = { ...CODEX, model: "model-c", label: "Model C" };
  expect(parseRecommended(JSON.stringify([CODEX, GOOSE, backup]))).toEqual([
    CODEX,
    GOOSE,
    backup,
  ]);
  expect(parseRecommended("  ")).toEqual([]);
  for (const invalid of [
    "[]",
    "{}",
    "nope",
    JSON.stringify([{ ...CODEX, provider: "p" }]),
    JSON.stringify([{ ...GOOSE, provider: "" }]),
    JSON.stringify([{ ...GOOSE, harness: "pi" }]),
    JSON.stringify([{ ...CODEX, label: "" }]),
    JSON.stringify([{ ...CODEX, extra: "x" }]),
  ])
    expect(() => parseRecommended(invalid)).toThrow(/BUZZ_RECOMMENDED_AGENT/);
});

it("names the candidate and field a build rejects, never their values", () => {
  for (const [list, message] of [
    ["nope", "BUZZ_RECOMMENDED_AGENT must be a JSON array"],
    [[GOOSE, "secret-text"], "BUZZ_RECOMMENDED_AGENT[1] must be an object."],
    [
      [GOOSE, { ...CODEX, harness: "secret-harness" }],
      "BUZZ_RECOMMENDED_AGENT[1].harness must be goose or codex.",
    ],
    [
      [{ ...GOOSE, model: " secret-model " }],
      "BUZZ_RECOMMENDED_AGENT[0].model must be text without surrounding spaces.",
    ],
    [
      [{ ...GOOSE, provider: "" }],
      "BUZZ_RECOMMENDED_AGENT[0].provider must be text without surrounding spaces.",
    ],
    [
      [CODEX, { ...CODEX, provider: "secret-provider" }],
      "BUZZ_RECOMMENDED_AGENT[1].provider is only for goose.",
    ],
    [
      [{ ...CODEX, extra: "secret-value" }],
      'BUZZ_RECOMMENDED_AGENT[0] has an unknown field, "extra".',
    ],
  ] as const) {
    const text = typeof list === "string" ? list : JSON.stringify(list);
    let thrown = "";
    try {
      parseRecommended(text);
    } catch (error) {
      thrown = String((error as Error).message);
    }
    expect(thrown).toContain(message);
    expect(thrown).not.toMatch(/secret/);
  }
});
