import { expect, it } from "vitest";
import { withProposedSettings } from "./proposal";

const saved = {
  provider: "openai",
  model: "gpt-4o",
  effort: "high",
  instructions: "Be brief.",
};

it("resets what a new provider or model leaves stale, unless proposed", () => {
  expect(withProposedSettings({ provider: "anthropic" }, saved)).toEqual({
    ...saved,
    provider: "anthropic",
    model: "",
    effort: "",
  });
  expect(withProposedSettings({ model: "o3" }, saved)).toEqual({
    ...saved,
    model: "o3",
    effort: "",
  });
  expect(
    withProposedSettings(
      { provider: "anthropic", model: "sonnet", effort: "low" },
      saved,
    ),
  ).toEqual({
    ...saved,
    provider: "anthropic",
    model: "sonnet",
    effort: "low",
  });
});

it("keeps settings the proposal leaves as they are", () => {
  expect(withProposedSettings({ effort: "low" }, saved)).toEqual({
    ...saved,
    effort: "low",
  });
  expect(
    withProposedSettings({ provider: "openai", model: "gpt-4o" }, saved),
  ).toEqual(saved);
  // A type without a provider gains none.
  const { provider: _, ...plain } = saved;
  expect(withProposedSettings({ model: "o3" }, plain)).toEqual({
    ...plain,
    model: "o3",
    effort: "",
  });
});
