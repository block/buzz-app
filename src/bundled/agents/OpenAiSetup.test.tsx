// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSettingsFields } from "./AgentSettingsFields";
import { agentDraft, agentEdit, type AgentDraft } from "./agent-edit";
import { controlFixture } from "../../features/agents/control-testing";
import { createAgentControl } from "../../features/agents/control";
import type { ModelCatalog, ModelRequest } from "../../features/agents/models";

afterEach(cleanup);
const catalog: ModelCatalog = {
  integration: { kind: "openai" },
  models: [
    { id: "test-model", name: "test-model", effort: { status: "default" } },
  ],
  discovery: {
    source: "openaiCatalog",
    authentication: "authenticated",
    catalog: "remote",
  },
  disconnected: false,
  modelOverridden: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(
  run: (ticket: number, request: ModelRequest) => Promise<ModelCatalog>,
  initial?: Partial<AgentDraft>,
) {
  const f = controlFixture();
  const cancel = vi.fn(async () => {});
  f.host.models = { begin: vi.fn(async () => 1), run, cancel };
  const control = createAgentControl(f.host);
  const validated = vi.fn();
  let latest!: AgentDraft;
  function Form() {
    const [draft, setDraft] = useState<AgentDraft>({
      ...agentDraft(f.agent),
      command: "buzz-agent",
      provider: "openai",
      model: "",
      configuration: { mode: "advanced", effort: { kind: "default" } },
      ...initial,
    });
    latest = draft;
    return (
      <AgentSettingsFields
        draft={draft}
        control={control}
        disabled={false}
        state={{
          status: "ready",
          busy: false,
          error: null,
          data: {
            agents: [],
            runtimeAvailable: true,
            configurationAvailable: true,
            harnessOptions: [
              {
                id: "buzz-agent",
                command: "buzz-agent",
                label: "Buzz Agent",
                capabilities: { modelDiscovery: "databricks", openai: true },
                providers: [
                  { value: "openai", label: "Open AI" },
                  { value: "databricks_v2", label: "Databricks v2" },
                ],
              },
              {
                id: "codex",
                command: "codex-acp",
                label: "Codex",
                capabilities: { modelDiscovery: "codex" },
                providers: [],
              },
            ],
          },
        }}
        onValidated={validated}
        onChange={(patch) => setDraft((old) => ({ ...old, ...patch }))}
      />
    );
  }
  const view = render(
    <StrictMode>
      <Form />
    </StrictMode>,
  );
  return { ...view, control, cancel, validated, draft: () => latest };
}

it("explicitly selecting an imported agent's existing model establishes Runtime default effort", async () => {
  const f = fixture(
    vi.fn(async () => catalog),
    { model: "test-model", configuration: undefined },
  );
  const user = userEvent.setup();
  try {
    await user.type(screen.getByLabelText("Open AI API Key"), "synthetic-key");
    await user.click(
      screen.getByRole("button", { name: "Check key and load models" }),
    );
    await screen.findByText(/A checked key is selected/);
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await user.click(await screen.findByRole("option", { name: /test-model/ }));
    expect(f.draft().configuration).toEqual({
      mode: "advanced",
      effort: { kind: "default" },
    });
    await waitFor(() =>
      expect(f.validated).toHaveBeenLastCalledWith(f.draft()),
    );
  } finally {
    f.unmount();
    f.control.dispose();
  }
});

it("checks a masked key, stages it for agent Save, and refreshes using the environment draft", async () => {
  const pending = deferred<ModelCatalog>();
  const run = vi.fn(
    (_ticket: number, _request: ModelRequest) => pending.promise,
  );
  const f = fixture(run);
  const user = userEvent.setup();
  try {
    const input = screen.getByLabelText("Open AI API Key");
    expect(input).toHaveAttribute("type", "password");
    expect(run).not.toHaveBeenCalled();
    await user.type(input, "synthetic-key");
    expect(JSON.stringify(agentEdit(f.draft()))).not.toContain("synthetic-key");
    await user.click(
      screen.getByRole("button", { name: "Check key and load models" }),
    );
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(input).toHaveValue("");
    expect(run.mock.calls[0]?.[1].integration).toEqual({
      kind: "openai",
      settings: { apiKey: "synthetic-key" },
    });
    expect(
      screen.getByRole("button", { name: "Cancel model request" }),
    ).toBeVisible();
    await act(async () => pending.resolve(catalog));
    await screen.findByText(/A checked key is selected/);
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await user.click(await screen.findByRole("option", { name: /test-model/ }));
    await waitFor(() =>
      expect(f.validated).toHaveBeenLastCalledWith(f.draft()),
    );
    expect(f.draft().model).toBe("test-model");
    expect(f.draft().configuration).toEqual({
      mode: "advanced",
      effort: { kind: "default" },
    });
    const saved = agentEdit(f.draft());
    expect(saved.environment.OPENAI_COMPAT_API_KEY).toBe("synthetic-key");
    expect(saved.harness).not.toHaveProperty("openaiCredential");
    await user.click(screen.getByRole("button", { name: "Refresh models" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]?.[1].integration).toEqual({
      kind: "openai",
      settings: {},
    });
    expect(run.mock.calls[1]?.[1].edit?.environment.OPENAI_COMPAT_API_KEY).toBe(
      "synthetic-key",
    );
  } finally {
    pending.resolve(catalog);
    f.unmount();
    f.control.dispose();
  }
});

it("provider changes retire a pending key request and late success cannot change the environment draft", async () => {
  const pending = deferred<ModelCatalog>();
  const run = vi.fn(() => pending.promise);
  const f = fixture(run);
  const user = userEvent.setup();
  try {
    await user.type(screen.getByLabelText("Open AI API Key"), "synthetic-key");
    await user.click(
      screen.getByRole("button", { name: "Check key and load models" }),
    );
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    await user.click(
      await screen.findByRole("option", { name: "Databricks v2" }),
    );
    await waitFor(() => expect(f.cancel).toHaveBeenCalledWith(1));
    await act(async () => pending.resolve(catalog));
    expect(screen.queryByLabelText("Open AI API Key")).toBeNull();
    expect(f.draft().environment.OPENAI_COMPAT_API_KEY).toBeUndefined();
    expect(f.draft().provider).toBe("databricks_v2");
  } finally {
    pending.resolve(catalog);
    f.unmount();
    f.control.dispose();
  }
});

it("rejected replacement clears input while retaining the previous environment key and model", async () => {
  const run = vi.fn(async () => {
    throw { code: "authentication", message: "Synthetic rejection" };
  });
  const f = fixture(run, {
    environment: { OPENAI_COMPAT_API_KEY: "previous-key" },
    model: "saved-model",
  });
  const user = userEvent.setup();
  try {
    await user.type(
      screen.getByLabelText("Open AI API Key"),
      "synthetic-replacement",
    );
    await user.click(
      screen.getByRole("button", { name: "Check key and load models" }),
    );
    await screen.findByText("Synthetic rejection");
    expect(screen.getByLabelText("Open AI API Key")).toHaveValue("");
    expect(f.draft().environment.OPENAI_COMPAT_API_KEY).toBe("previous-key");
    expect(f.draft().model).toBe("saved-model");
    expect(f.validated).toHaveBeenLastCalledWith(null);
  } finally {
    f.unmount();
    f.control.dispose();
  }
});

it("unmount cancels setup and reopening never restores entered key text", async () => {
  const pending = deferred<ModelCatalog>();
  const run = vi.fn(() => pending.promise);
  const user = userEvent.setup();
  const f = fixture(run);
  await user.type(screen.getByLabelText("Open AI API Key"), "synthetic-key");
  await user.click(
    screen.getByRole("button", { name: "Check key and load models" }),
  );
  await waitFor(() => expect(run).toHaveBeenCalledOnce());
  f.unmount();
  f.control.dispose();
  await waitFor(() => expect(f.cancel).toHaveBeenCalledWith(1));
  await act(async () => pending.resolve(catalog));
  const reopened = fixture(vi.fn(async () => catalog));
  expect(screen.getByLabelText("Open AI API Key")).toHaveValue("");
  reopened.unmount();
  reopened.control.dispose();
});
