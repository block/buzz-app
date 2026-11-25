import { expect, test } from "vitest";
import { shownModels } from "./setup";

const model = (id: string, label: string) => ({ id, label, thinking: [] });

test("sorts provider models naturally by label without mutating input", () => {
  const input = [
    model("gpt-10", "GPT-10"),
    model("claude-opus-4-5", "Claude Opus 4.5"),
    model("gpt-2", "GPT-2"),
    model("claude-fable-5-2", "Claude Fable 5.2"),
  ];
  expect(shownModels(input).map(({ label }) => label)).toEqual([
    "Claude Fable 5.2",
    "Claude Opus 4.5",
    "GPT-2",
    "GPT-10",
  ]);
  expect(input.map(({ id }) => id)).toEqual([
    "gpt-10",
    "claude-opus-4-5",
    "gpt-2",
    "claude-fable-5-2",
  ]);
});
