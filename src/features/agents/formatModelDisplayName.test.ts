import { expect, it } from "vitest";
import {
  formatModelChoices,
  formatModelDisplayName,
} from "./formatModelDisplayName";

const PREFIXES = ["databricks-", "goose-"];

it.each([
  ["databricks-claude-opus-4-7", "Claude Opus 4.7"],
  ["databricks-gpt-6-1-sol", "GPT-6.1 Sol"],
  ["goose-gpt-5-5", "GPT-5.5"],
  ["databricks-meta-llama-3-3-70b", "Meta Llama 3.3 70B"],
  ["system.ai.gpt-6-1-sol", "GPT-6.1 Sol"],
  ["data_workflow_tools.goose.goose-gpt-6-1-sol", "GPT-6.1 Sol"],
  ["custom-endpoint", "custom-endpoint"],
  ["auto-labeler-builderbot-gpt-6-luna", "auto-labeler-builderbot-gpt-6-luna"],
  ["Claude Opus 4.7", "Claude Opus 4.7"],
  ["system.ai.constructor", "Constructor"],
  ["system.ai.__proto__", "__proto__"],
])("formats %s as %s", (id, label) => {
  expect(formatModelDisplayName(id, PREFIXES)).toBe(label);
});

it("leaves names alone without provider prefixes", () => {
  expect(formatModelDisplayName("goose-custom-model")).toBe(
    "goose-custom-model",
  );
  expect(formatModelDisplayName("system.ai.gpt-6-1-sol")).toBe(
    "system.ai.gpt-6-1-sol",
  );
});

const choices = (ids: readonly string[], prefixes = PREFIXES) =>
  formatModelChoices(
    ids.map((id) => ({ id, label: id })),
    prefixes,
  ).map(({ id, label, qualifier }) => ({ id, label, qualifier }));

it("qualifies a name served from several catalogs with its catalog.schema", () => {
  expect(
    choices([
      "system.ai.gpt-6-1-sol",
      "data_workflow_tools.goose.goose-gpt-6-1-sol",
      "system.ai.claude-opus-5-5",
    ]),
  ).toEqual([
    {
      id: "system.ai.gpt-6-1-sol",
      label: "GPT-6.1 Sol",
      qualifier: "system.ai",
    },
    {
      id: "data_workflow_tools.goose.goose-gpt-6-1-sol",
      label: "GPT-6.1 Sol",
      qualifier: "data_workflow_tools.goose",
    },
    {
      id: "system.ai.claude-opus-5-5",
      label: "Claude Opus 5.5",
      qualifier: undefined,
    },
  ]);
});

it("qualifies workspace endpoints by prefix, ignoring case", () => {
  expect(
    formatModelChoices(
      [
        { id: "databricks-gpt-5-4-mini", label: "databricks-gpt-5-4-mini" },
        { id: "goose-gpt-5-4-MINI", label: "goose-gpt-5-4-MINI" },
      ],
      PREFIXES,
    ).map(({ label, qualifier }) => [label, qualifier]),
  ).toEqual([
    ["GPT-5.4 Mini", "databricks"],
    ["GPT-5.4 MINI", "goose"],
  ]);
});

it("qualifies names still alike after their source with their full ID", () => {
  expect(
    choices([
      "system.ai.goose-gpt-6-luna",
      "system.ai.databricks-gpt-6-luna",
      "goose-gpt-6-luna",
    ]).map(({ qualifier }) => qualifier),
  ).toEqual([
    "system.ai.goose-gpt-6-luna",
    "system.ai.databricks-gpt-6-luna",
    "goose",
  ]);
});

it("qualifies the default row by the model its label names", () => {
  expect(
    formatModelChoices(
      [
        { id: "", label: "data_workflow_tools.goose.goose-gpt-6-1-sol" },
        {
          id: "data_workflow_tools.goose.goose-gpt-6-1-sol",
          label: "data_workflow_tools.goose.goose-gpt-6-1-sol",
        },
        { id: "system.ai.gpt-6-1-sol", label: "system.ai.gpt-6-1-sol" },
      ],
      PREFIXES,
    ).map(({ qualifier }) => qualifier),
  ).toEqual([
    "data_workflow_tools.goose",
    "data_workflow_tools.goose",
    "system.ai",
  ]);
});

it("leaves unformatted names, the default row and other providers alone", () => {
  expect(
    formatModelChoices(
      [
        { id: "", label: "goose-gpt-5-5" },
        { id: "goose-gpt-5-5", label: "goose-gpt-5-5" },
        { id: "custom-endpoint", label: "custom-endpoint" },
        { id: "other.custom-endpoint", label: "custom-endpoint" },
      ],
      PREFIXES,
    ).map(({ qualifier }) => qualifier),
  ).toEqual([undefined, undefined, undefined, undefined]);
  expect(
    choices(["system.ai.gpt-6", "data.goose.gpt-6"], []).map(
      ({ label, qualifier }) => [label, qualifier],
    ),
  ).toEqual([
    ["system.ai.gpt-6", undefined],
    ["data.goose.gpt-6", undefined],
  ]);
});
