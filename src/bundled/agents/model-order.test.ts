import { expect, it } from "vitest";
import { newestModelsFirst } from "./model-order";
const order = (names: string[]) =>
  newestModelsFirst(names.map((name) => ({ name, id: name }))).map(
    (m) => m.name,
  );
it("sorts generations numerically within families, retaining family positions", () => {
  expect(
    order([
      "Claude Sonnet 4.5",
      "GPT 5.2",
      "Claude Opus 4.6",
      "GPT 6.1",
      "Claude Sonnet 4.10",
    ]),
  ).toEqual([
    "Claude Sonnet 4.10",
    "GPT 6.1",
    "Claude Opus 4.6",
    "GPT 5.2",
    "Claude Sonnet 4.5",
  ]);
});
it("recognizes endpoint versions without ranking parameter counts as generations", () => {
  expect(
    order([
      "system.ai.llama-3-1-405b",
      "system.ai.llama-3-3-70b",
      "system.ai.llama-4-17b",
    ]),
  ).toEqual([
    "system.ai.llama-4-17b",
    "system.ai.llama-3-3-70b",
    "system.ai.llama-3-1-405b",
  ]);
  expect(
    order(["Kimi K2", "Kimi K2.5", "DeepSeek V3", "DeepSeek V3.2"]),
  ).toEqual(["Kimi K2.5", "Kimi K2", "DeepSeek V3.2", "DeepSeek V3"]);
});
it("preserves equal and unversioned catalog order", () => {
  expect(
    order(["Claude Sonnet 4.6", "Claude Opus 4.6", "Custom A", "Custom B"]),
  ).toEqual(["Claude Sonnet 4.6", "Claude Opus 4.6", "Custom A", "Custom B"]);
});
