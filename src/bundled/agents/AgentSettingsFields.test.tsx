// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentSettingsFields } from "./AgentSettingsFields";
import { agentDraft, agentEdit, type AgentDraft } from "./agent-edit";
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

function setup(savedKey = false) {
  const fixture = controlFixture();
  fixture.data.harnessOptions = [
    {
      command: "/usr/local/bin/goose",
      label: "Goose",
      defaultArgs: ["acp"],
      providers: [
        { value: "openai", label: "OpenAI" },
        { value: "anthropic", label: "Anthropic" },
        { value: "ollama", label: "Ollama" },
      ],
    },
  ];
  const run = vi.fn(async () => ({
    host: "",
    models: [{ id: "gpt-4o", name: "gpt-4o" }],
    modelOverridden: false,
    disconnected: false,
  }));
  fixture.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(fixture.host);
  let draft!: AgentDraft;
  function Editor() {
    const [value, setValue] = useState(() => ({
      ...agentDraft(fixture.agent),
      command: "/usr/local/bin/goose",
      args: '["acp"]',
      provider: "openai",
      model: "",
    }));
    draft = value;
    return (
      <AgentSettingsFields
        draft={value}
        control={control}
        state={{
          status: "ready",
          data: fixture.data,
          busy: false,
          error: null,
        }}
        disabled={false}
        environmentKeys={savedKey ? ["OPENAI_API_KEY"] : []}
        onChange={(patch) => setValue((current) => ({ ...current, ...patch }))}
      />
    );
  }
  const view = render(<Editor />);
  return { draft: () => draft, run, view, control };
}

it("uses a masked OpenAI key for Goose model lookup and discards unsaved keys on provider change", async () => {
  const { draft, run, view, control } = setup();
  const user = userEvent.setup();
  try {
    const key = screen.getByLabelText("OpenAI API key");
    expect(key).toHaveAttribute("type", "password");
    await user.type(key, "test-openai-key");
    expect(agentEdit(draft(), true).environment).toEqual({
      OPENAI_API_KEY: "test-openai-key",
    });
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        edit: expect.objectContaining({
          environment: { OPENAI_API_KEY: "test-openai-key" },
        }),
      }),
    );
    await screen.findByRole("option", { name: "gpt-4o" });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model" })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
    await user.click(screen.getByRole("combobox", { name: "LLM Provider" }));
    await user.click(await screen.findByRole("option", { name: "Anthropic" }));
    expect(screen.getByLabelText("Anthropic API key")).toHaveAttribute(
      "type",
      "password",
    );
    expect(draft().environment).toEqual({});
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("preserves a saved key when blank and replaces it only when entered", async () => {
  const { draft, view, control } = setup(true);
  const user = userEvent.setup();
  try {
    expect(screen.getByLabelText("OpenAI API key")).toHaveAttribute(
      "placeholder",
      "Saved key unchanged",
    );
    expect(agentEdit(draft()).environment).toEqual({});
    await user.type(screen.getByLabelText("OpenAI API key"), "replacement-key");
    expect(agentEdit(draft()).environment).toEqual({
      OPENAI_API_KEY: "replacement-key",
    });
    await user.clear(screen.getByLabelText("OpenAI API key"));
    expect(agentEdit(draft()).environment).toEqual({});
  } finally {
    view.unmount();
    control.dispose();
  }
});
