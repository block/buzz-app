// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AgentSettingsFields } from "./AgentSettingsFields";
import { agentDraft, type AgentDraft } from "./agent-edit";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";

afterEach(cleanup);

it("only hints the compiled model when the current provider and overrides can use it", () => {
  const f = controlFixture();
  const control = createAgentControl(f.host);
  const onChange = vi.fn();
  const base = {
    ...agentDraft(f.agent),
    command: "buzz-agent",
    provider: "",
    model: "",
  };
  const cases: {
    provider: string;
    draft?: Partial<AgentDraft>;
    keys?: string[];
    hint: boolean;
  }[] = [
    { provider: "databricks_v2", hint: true },
    { provider: "databricks-v2", hint: true },
    { provider: "databricks", hint: true },
    { provider: "openai", hint: false },
    { provider: "", hint: false },
    { provider: "databricks_v2", draft: { provider: "openai" }, hint: false },
    { provider: "openai", draft: { provider: "databricks_v2" }, hint: true },
    {
      provider: "databricks_v2",
      draft: { environment: { BUZZ_AGENT_PROVIDER: "openai" } },
      hint: false,
    },
    {
      provider: "databricks_v2",
      draft: { environment: { BUZZ_AGENT_PROVIDER: "" } },
      hint: false,
    },
    {
      provider: "openai",
      draft: { environment: { BUZZ_AGENT_PROVIDER: "databricks-v2" } },
      hint: true,
    },
    { provider: "databricks_v2", keys: ["BUZZ_AGENT_PROVIDER"], hint: false },
    {
      provider: "databricks_v2",
      keys: ["BUZZ_AGENT_PROVIDER"],
      draft: { environment: { BUZZ_AGENT_PROVIDER: null } },
      hint: true,
    },
    { provider: "databricks_v2", keys: ["BUZZ_AGENT_MODEL"], hint: false },
    { provider: "databricks_v2", keys: ["DATABRICKS_MODEL"], hint: false },
    {
      provider: "databricks_v2",
      draft: { environment: { BUZZ_AGENT_MODEL: "" } },
      hint: false,
    },
    {
      provider: "databricks_v2",
      draft: { environment: { DATABRICKS_MODEL: "custom" } },
      hint: false,
    },
    {
      provider: "databricks_v2",
      keys: ["DATABRICKS_MODEL"],
      draft: { environment: { DATABRICKS_MODEL: null } },
      hint: true,
    },
    {
      provider: "databricks_v2",
      draft: { command: "goose", provider: "databricks_v2" },
      hint: false,
    },
    {
      provider: "databricks_v2",
      draft: { command: "/local/bin/buzz-pi-acp" },
      hint: false,
    },
    {
      provider: "databricks_v2",
      draft: { command: "/local/bin/buzz-pi-acp", provider: "databricks_v2" },
      hint: false,
    },
    {
      provider: "databricks_v2",
      draft: { command: "custom-acp" },
      hint: false,
    },
  ];
  const fields = (entry: (typeof cases)[number]) => (
    <AgentSettingsFields
      draft={{ ...base, ...entry.draft }}
      control={control}
      state={{
        status: "ready",
        busy: false,
        error: null,
        data: {
          ...f.data,
          agentDefaults: {
            provider: entry.provider,
            model: "build-model",
            ownerOnly: false,
          },
        },
      }}
      disabled={false}
      environmentKeys={entry.keys ?? []}
      onChange={onChange}
    />
  );
  const view = render(fields({ provider: "databricks_v2", hint: true }));
  try {
    for (const entry of cases) {
      view.rerender(fields(entry));
      expect(
        screen.getByRole("combobox", { name: "Model" }),
        JSON.stringify(entry),
      ).toHaveAttribute(
        "placeholder",
        entry.hint ? "Build default: build-model" : "Choose or enter a model",
      );
    }
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    control.dispose();
  }
});
