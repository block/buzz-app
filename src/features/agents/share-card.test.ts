import { expect, it } from "vitest";
import { cardModel } from "./share-card";

it("doesn't repeat the harness in the model", () => {
  expect(cardModel("Claude", "claude-opus-5-5")).toBe("Opus 5.5");
  expect(cardModel("Claude", "claude-sonnet-5-5-20260901")).toBe("Sonnet 5.5");
  expect(cardModel("Claude", "opus")).toBe("Opus");
});

it("names the model in full under another harness", () => {
  expect(cardModel("Goose", "databricks · claude-opus-5-5")).toBe(
    "Databricks · Claude Opus 5.5",
  );
  expect(cardModel("Codex", "gpt-5-codex")).toBe("gpt-5-codex");
});

it("says Default for an agent on its harness's default model", () => {
  expect(cardModel("Claude", "Claude")).toBe("Default");
  expect(cardModel("Codex", "")).toBe("Default");
});

it("keeps a model that only starts like the harness", () => {
  expect(cardModel("Claude", "claudette-large")).toBe("claudette-large");
});
