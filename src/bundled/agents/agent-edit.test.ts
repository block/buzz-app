import { expect, it } from "vitest";
import { controlFixture } from "../../features/agents/control-testing";
import { agentDraft, agentEdit, agentProcessLabel } from "./agent-edit";
it("round-trips literal arguments including spaces and quotes; no opaque fields in edits", () => {
  const agent = controlFixture().agent;
  const draft = agentDraft(agent);
  expect(agentEdit(draft).harness.args).toEqual([
    "--literal",
    "two words",
    'quoted "value"',
  ]);
  expect(agentEdit(draft).environment).toEqual({});
  expect(agentEdit(draft)).not.toHaveProperty("pubkey");
  expect(agentEdit(draft).harness).not.toHaveProperty("environmentKeys");
});
it("validates without echoing rejected arguments or losing a draft", () => {
  const draft = agentDraft(controlFixture().agent);
  draft.args = "not-json";
  expect(() => agentEdit(draft)).toThrow("JSON array");
  expect(draft.args).toBe("not-json");
  for (const invalid of ["{}", "[1]", "null"])
    expect(() => agentEdit({ ...draft, args: invalid })).toThrow("JSON array");
});
it("environment patches distinguish preserve, replacement, empty and removal", () => {
  const draft = agentDraft(controlFixture().agent);
  expect(agentEdit(draft).environment).toEqual({});
  draft.environment = { REPLACE: "fixture-value", EMPTY: "", DELETE: null };
  expect(agentEdit(draft).environment).toEqual(draft.environment);
});
it("process-alive never claims relay readiness", () => {
  expect(agentProcessLabel(controlFixture().agent)).toBe(
    "Process running · relay readiness unverified",
  );
});

it("refuses argument values unsupported by the current ACP transport", () => {
  const draft = agentDraft(controlFixture().agent);
  for (const args of ['[""]', '["a,b"]']) {
    expect(() => agentEdit({ ...draft, args })).toThrow(
      "nonempty and cannot contain commas",
    );
  }
});

it("persists connection edits, preserves saved blanks, and clones private-build defaults", () => {
  const agent = controlFixture().agent;
  const defaults = { host: "https://workspace.example", filter: "llm" };
  const draft = agentDraft(agent, defaults);
  expect(agentEdit(draft).harness.databricks).toEqual(defaults);
  if (!draft.databricks) throw new Error("Missing connection draft");
  draft.databricks.host = "https://other.example";
  expect(defaults.host).toBe("https://workspace.example");
  agent.harness.databricks = { host: "", filter: "" };
  const saved = agentDraft(agent, defaults);
  expect(agentEdit(saved).harness.databricks).toEqual({ host: "", filter: "" });
});
