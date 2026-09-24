// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentModelPicker } from "./AgentModelPicker";
import { agentDraft } from "./agent-edit";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";

afterEach(cleanup);
for (const opening of ["typing", "ArrowDown", "closed"] as const) {
  it(`${opening}: only explicit Browse or Retry may connect the actual combobox`, async () => {
    const f = controlFixture();
    const begin = vi.fn(async () => 1);
    const run = vi.fn(async () => {
      throw "Synthetic sign-in failure";
    });
    const cancel = vi.fn(async () => {});
    f.host.models = { begin, run, cancel };
    const control = createAgentControl(f.host);
    const user = userEvent.setup();
    function Editor() {
      const [draft, setDraft] = useState(agentDraft(f.agent));
      return (
        <AgentModelPicker
          capabilities={{ modelDiscovery: "databricks" }}
          draft={draft}
          control={control}
          defaults={{ host: "https://workspace.example.com", filter: "" }}
          onChange={(patch) =>
            setDraft((current) => ({ ...current, ...patch }))
          }
        />
      );
    }
    const view = render(<Editor />);
    try {
      const input = screen.getByRole("combobox", { name: "Model" });
      // Base UI intentionally aria-hides controls outside the open list from
      // virtual cursors; pointer/Tab access remains. Capture the real trigger.
      const browse = screen.getByRole("button", { name: "Browse models" });
      if (opening === "typing") {
        await user.clear(input);
        await user.type(input, "custom-model");
      } else if (opening === "ArrowDown") {
        await user.click(input);
        await user.keyboard("{ArrowDown}");
      }
      if (opening !== "closed")
        expect(input).toHaveAttribute("aria-expanded", "true");
      expect(begin).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      if (opening === "ArrowDown") {
        await user.tab();
        expect(browse).toHaveFocus();
        await user.keyboard("{Enter}");
      } else await user.click(browse);
      // Base UI defers the trigger's mousedown toggle to the next frame. Assert
      // only after that callback, not whichever side of it userEvent happened to finish.
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      await screen.findByText("Synthetic sign-in failure");
      expect(begin).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledExactlyOnceWith(
        1,
        expect.objectContaining({ action: "connect" }),
      );
      expect(input).toHaveAttribute("aria-expanded", "true");
      if (opening === "typing") expect(input).toHaveValue("custom-model");
      await user.keyboard("{Escape}");
      await user.click(input);
      await user.keyboard("{ArrowDown}");
      expect(run).toHaveBeenCalledOnce();
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "Retry models" }));
      await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    } finally {
      view.unmount();
      control.dispose();
    }
  });
}

it("missing host metadata preserves custom entry without issuing incompatible IPC", async () => {
  const f = controlFixture();
  const begin = vi.fn(async () => 1);
  f.host.models = { begin, run: vi.fn(), cancel: vi.fn() };
  const control = createAgentControl(f.host);
  const onChange = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <AgentModelPicker
      draft={agentDraft(f.agent)}
      control={control}
      defaults={undefined}
      onChange={onChange}
    />,
  );
  try {
    expect(screen.getByText(/Model browsing is unavailable/)).toBeVisible();
    const input = screen.getByRole("combobox", { name: "Model" });
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await user.clear(input);
    await user.type(input, "retained.custom");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith({ model: "retained.custom" });
    expect(begin).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("context change cancels a pending catalog and rejects its late result", async () => {
  const f = controlFixture();
  let release!: (
    value: import("../../features/agents/models").ModelCatalog,
  ) => void;
  const pending = new Promise<
    import("../../features/agents/models").ModelCatalog
  >((resolve) => {
    release = resolve;
  });
  const run = vi.fn(() => pending);
  const cancel = vi.fn(async () => {});
  f.host.models = { begin: async () => 7, run, cancel };
  const control = createAgentControl(f.host);
  const user = userEvent.setup();
  const draft = agentDraft(f.agent);
  const props = {
    control,
    defaults: { host: "https://workspace.example.com", filter: "" },
    capabilities: { modelDiscovery: "databricks" as const },
    onChange: vi.fn(),
  };
  const view = render(<AgentModelPicker {...props} draft={draft} />);
  try {
    const input = screen.getByRole("combobox", { name: "Model" });
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    // Complete Base UI's deferred trigger toggle before changing context.
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    });
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    view.rerender(
      <AgentModelPicker
        {...props}
        draft={{ ...draft, command: "/changed/agent" }}
      />,
    );
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(7));
    await act(async () => {
      release({
        integration: { kind: "databricks", host: props.defaults.host },
        models: [{ id: "stale", name: "Stale result" }],
        modelOverridden: true,
        disconnected: false,
      });
      await pending;
    });
    await waitFor(() =>
      expect(input).toHaveAttribute("aria-expanded", "false"),
    );
    await user.click(input);
    await user.keyboard("{ArrowDown}");
    expect(screen.queryByText("Stale result")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/saved BUZZ_AGENT_MODEL override/),
    ).not.toBeInTheDocument();
    expect(props.onChange).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("Disconnect remains recovery when the edited harness has no discovery capability", async () => {
  const f = controlFixture();
  const run = vi.fn(async () => ({
    integration: {
      kind: "databricks" as const,
      host: "https://workspace.example.com",
    },
    models: [],
    modelOverridden: false,
    disconnected: true,
  }));
  f.host.models = { begin: async () => 8, run, cancel: vi.fn(async () => {}) };
  const control = createAgentControl(f.host);
  const user = userEvent.setup();
  const view = render(
    <AgentModelPicker
      draft={agentDraft(f.agent)}
      control={control}
      capabilities={{ modelDiscovery: null }}
      recoveryAvailable
      defaults={{ host: "https://workspace.example.com", filter: "" }}
      onChange={vi.fn()}
    />,
  );
  try {
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(
      screen.queryByRole("button", { name: "Refresh models" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await screen.findByText("Disconnected from this workspace in Foundation.");
    expect(run).toHaveBeenCalledExactlyOnceWith(
      8,
      expect.objectContaining({
        action: "disconnect",
        edit: undefined,
        integration: {
          kind: "databricks",
          settings: { host: "https://workspace.example.com", filter: "" },
        },
      }),
    );
  } finally {
    view.unmount();
    control.dispose();
  }
});

for (const change of [
  "unchanged",
  "model",
  "effort",
  "cached",
  "fallback",
  "unknown",
] as const) {
  it(`Advanced refresh preserves the draft and validates ${change} catalog evidence`, async () => {
    const f = controlFixture();
    const catalog: import("../../features/agents/models").ModelCatalog = {
      integration: {
        kind: "databricks",
        host: "https://workspace.example.com",
      },
      models: [
        {
          id: "chosen",
          name: "Chosen model",
          effort: {
            status: "supported",
            options: [{ value: "high", name: "High" }],
          },
        },
      ],
      discovery: {
        source: "databricksCatalog",
        authentication: "authenticated",
        catalog: "remote",
      },
      disconnected: false,
      modelOverridden: false,
    };
    let next = catalog;
    const run = vi.fn(async () => next);
    f.host.models = {
      begin: async () => 1,
      run,
      cancel: vi.fn(async () => {}),
    };
    const control = createAgentControl(f.host);
    const draft = {
      ...agentDraft(f.agent),
      model: "chosen",
      configuration: {
        mode: "advanced" as const,
        effort: { kind: "value" as const, value: "high" },
      },
    };
    const onChange = vi.fn();
    const onValidated = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <AgentModelPicker
        draft={draft}
        control={control}
        defaults={{ host: "https://workspace.example.com", filter: "" }}
        capabilities={{ modelDiscovery: "databricks" }}
        onChange={onChange}
        onValidated={onValidated}
      />,
    );
    try {
      await user.click(screen.getByRole("button", { name: "Refresh models" }));
      await waitFor(() => expect(onValidated).toHaveBeenLastCalledWith(draft));
      expect(run).toHaveBeenLastCalledWith(
        1,
        expect.objectContaining({ action: "refresh" }),
      );
      next =
        change === "model"
          ? { ...catalog, models: [] }
          : change === "effort"
            ? {
                ...catalog,
                models: [
                  {
                    id: "chosen",
                    name: "Chosen model",
                    effort: {
                      status: "supported",
                      options: [{ value: "low", name: "Low" }],
                    },
                  },
                ],
              }
            : change === "unchanged"
              ? catalog
              : {
                  ...catalog,
                  discovery: {
                    source: "databricksCatalog",
                    authentication: "authenticated",
                    catalog: change,
                  },
                };
      await user.click(screen.getByRole("button", { name: "Refresh models" }));
      await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Refresh models" }),
        ).toBeEnabled(),
      );
      expect(onValidated).toHaveBeenLastCalledWith(
        change === "unchanged" ? draft : null,
      );
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
        change === "model" ||
          change === "cached" ||
          change === "fallback" ||
          change === "unknown"
          ? "chosen"
          : "Chosen model",
      );
    } finally {
      view.unmount();
      control.dispose();
    }
  });
}

it("Advanced refresh auth failure requires an explicit Connect account action", async () => {
  const { ModelError } = await import("../../features/agents/models");
  const f = controlFixture();
  const run = vi.fn(async () => {
    throw new ModelError("authentication", "Sign in to this account.");
  });
  f.host.models = { begin: async () => 1, run, cancel: vi.fn(async () => {}) };
  const control = createAgentControl(f.host);
  const onChange = vi.fn();
  const onValidated = vi.fn();
  const draft = {
    ...agentDraft(f.agent),
    configuration: {
      mode: "advanced" as const,
      effort: { kind: "unsupported" as const },
    },
  };
  const user = userEvent.setup();
  const view = render(
    <AgentModelPicker
      draft={draft}
      control={control}
      defaults={{ host: "https://workspace.example.com", filter: "" }}
      capabilities={{ modelDiscovery: "databricks" }}
      onChange={onChange}
      onValidated={onValidated}
    />,
  );
  try {
    await user.click(screen.getByRole("button", { name: "Refresh models" }));
    await screen.findByText("Sign in to this account.");
    expect(run).toHaveBeenCalledExactlyOnceWith(
      1,
      expect.objectContaining({ action: "refresh" }),
    );
    expect(onValidated).toHaveBeenLastCalledWith(null);
    expect(
      screen.queryByRole("button", { name: "Retry models" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect account" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ action: "connect" }),
    );
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("Codex trusts adapter choices, exposes only model-specific effort, and sends headless requests", async () => {
  const f = controlFixture();
  const run = vi.fn(async () => ({
    integration: { kind: "codex" as const },
    discovery: {
      source: "codexAcp" as const,
      authentication: "authenticated" as const,
      catalog: "adapter" as const,
    },
    models: [
      {
        id: "second",
        name: "Second",
        effort: {
          status: "supported" as const,
          options: [{ value: "high", name: "High" }],
        },
      },
    ],
    modelOverridden: false,
    disconnected: false,
  }));
  f.host.models = { begin: async () => 1, run, cancel: vi.fn(async () => {}) };
  const control = createAgentControl(f.host);
  const onValidated = vi.fn();
  const user = userEvent.setup();
  function Editor() {
    const [draft, setDraft] = useState({
      ...agentDraft(f.agent),
      command: "codex-acp",
      provider: "",
      model: "second",
      configuration: {
        mode: "advanced" as const,
        effort: { kind: "unsupported" as const },
      },
    } as import("./agent-edit").AgentDraft);
    return (
      <AgentModelPicker
        draft={draft}
        control={control}
        defaults={undefined}
        capabilities={{ modelDiscovery: "codex" }}
        recoveryAvailable
        onChange={(patch) => setDraft((old) => ({ ...old, ...patch }))}
        onValidated={onValidated}
      />
    );
  }
  const view = render(<Editor />);
  try {
    const effort = await screen.findByRole("combobox", { name: "Effort" });
    expect(onValidated).toHaveBeenLastCalledWith(null);
    await user.click(effort);
    await user.click(await screen.findByRole("option", { name: "High" }));
    await waitFor(() =>
      expect(onValidated).toHaveBeenLastCalledWith(
        expect.objectContaining({
          configuration: {
            mode: "advanced",
            effort: { kind: "value", value: "high" },
          },
        }),
      ),
    );
    expect(run).toHaveBeenCalledExactlyOnceWith(
      1,
      expect.objectContaining({
        integration: { kind: "codex" },
        action: "refresh",
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Connect account" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Disconnect" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/may be cached/)).toBeVisible();
    run.mockRejectedValueOnce("Discovery temporarily unavailable");
    await user.click(screen.getByRole("button", { name: "Refresh models" }));
    await screen.findByText("Discovery temporarily unavailable");
    expect(onValidated).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("button", { name: "Retry models" })).toBeEnabled();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("loads Codex defaults in the background, reuses cached settings on remount, and fences a changed context", async () => {
  const f = controlFixture();
  const data = {
    integration: { kind: "codex" as const },
    discovery: {
      source: "codexAcp" as const,
      authentication: "authenticated" as const,
      catalog: "adapter" as const,
    },
    defaults: { model: "fixture-default", effort: "medium" },
    models: [{ id: "fixture-default", name: "Fixture model" }],
    modelOverridden: false,
    disconnected: false,
  };
  let release!: (value: typeof data) => void;
  const run = vi
    .fn()
    .mockResolvedValueOnce(data)
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
  f.host.models = { begin: async () => 1, run, cancel: vi.fn(async () => {}) };
  const control = createAgentControl(f.host);
  const draft = {
    ...agentDraft(f.agent),
    command: "codex-acp",
    provider: "",
    model: "",
    configuration: { mode: "default" as const },
  };
  const onChange = vi.fn();
  const props = {
    control,
    defaults: undefined,
    capabilities: { modelDiscovery: "codex" as const },
    onChange,
  };
  const view = render(
    <StrictMode>
      <AgentModelPicker {...props} draft={draft} />
    </StrictMode>,
  );
  try {
    await screen.findByText(/Default model: fixture-default · Effort: medium/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^Model$/ })).toBeNull();
    expect(onChange).not.toHaveBeenCalled(); // defaults remain delegated, not saved overrides
    view.unmount();
    const reopened = render(
      <StrictMode>
        <AgentModelPicker {...props} draft={draft} />
      </StrictMode>,
    );
    await screen.findByText(/Default model: fixture-default.*cached/);
    expect(run).toHaveBeenCalledTimes(1);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Refresh models" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    const oldRelease = release;
    reopened.rerender(
      <StrictMode>
        <AgentModelPicker
          {...props}
          draft={{ ...draft, workspace: "/other" }}
        />
      </StrictMode>,
    );
    await waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    await act(async () => oldRelease(data));
    expect(screen.queryByText(/Default model: fixture-default/)).toBeNull();
    await act(async () =>
      release({ ...data, defaults: { model: "other-default", effort: "low" } }),
    );
    expect(
      screen.getByText(/Default model: other-default · Effort: low/),
    ).toBeVisible();
    reopened.unmount();
  } finally {
    control.dispose();
  }
});

it("uses the complete Codex cache for model and mode changes without another probe", async () => {
  const f = controlFixture();
  const data = {
    integration: { kind: "codex" as const },
    discovery: {
      source: "codexAcp" as const,
      authentication: "authenticated" as const,
      catalog: "adapter" as const,
    },
    models: [
      {
        id: "first",
        name: "First",
        effort: {
          status: "supported" as const,
          options: [{ value: "low", name: "Low" }],
        },
      },
      {
        id: "second",
        name: "Second",
        effort: {
          status: "supported" as const,
          options: [{ value: "high", name: "High" }],
        },
      },
    ],
    modelOverridden: false,
    disconnected: false,
  };
  const run = vi.fn(async () => data);
  f.host.models = { begin: async () => 1, run, cancel: vi.fn(async () => {}) };
  const control = createAgentControl(f.host);
  const onValidated = vi.fn();
  const props = {
    control,
    defaults: undefined,
    capabilities: { modelDiscovery: "codex" as const },
    onValidated,
    onChange: vi.fn(),
  };
  const draft = {
    ...agentDraft(f.agent),
    command: "codex-acp",
    provider: "",
    model: "first",
    configuration: {
      mode: "advanced" as const,
      effort: { kind: "value" as const, value: "low" },
    },
  };
  const view = render(<AgentModelPicker {...props} draft={draft} />);
  try {
    await waitFor(() => expect(onValidated).toHaveBeenLastCalledWith(draft));
    const second = { ...draft, model: "second" };
    view.rerender(<AgentModelPicker {...props} draft={second} />);
    await waitFor(() => expect(onValidated).toHaveBeenLastCalledWith(null));
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Effort" }));
    expect(await screen.findByRole("option", { name: "High" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Low" })).toBeNull();
    await user.keyboard("{Escape}");
    const selected = {
      ...second,
      configuration: {
        mode: "advanced" as const,
        effort: { kind: "value" as const, value: "high" },
      },
    };
    view.rerender(<AgentModelPicker {...props} draft={selected} />);
    await waitFor(() => expect(onValidated).toHaveBeenLastCalledWith(selected));
    view.rerender(
      <AgentModelPicker
        {...props}
        draft={{ ...draft, model: "", configuration: { mode: "default" } }}
      />,
    );
    await screen.findByText(/Default model:/);
    view.rerender(<AgentModelPicker {...props} draft={selected} />);
    await waitFor(() => expect(onValidated).toHaveBeenLastCalledWith(selected));
    view.rerender(
      <AgentModelPicker
        {...props}
        draft={{ ...selected, model: "second[high]" }}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
      "Second",
    );
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    expect(
      await screen.findByRole("option", { name: /^Second/ }),
    ).toBeVisible();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("combobox", { name: "Effort" }));
    await user.click(await screen.findByRole("option", { name: "High" }));
    expect(props.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: "second",
        configuration: {
          mode: "advanced",
          effort: { kind: "value", value: "high" },
        },
      }),
    );
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("rediscovering an expired Codex cache on reopen reports the changed login state", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const f = controlFixture();
  const run = vi
    .fn()
    .mockResolvedValueOnce({
      integration: { kind: "codex" },
      discovery: {
        source: "codexAcp",
        authentication: "authenticated",
        catalog: "adapter",
      },
      defaults: { model: "old-account-model", effort: "medium" },
      models: [],
      modelOverridden: false,
      disconnected: false,
    })
    .mockRejectedValueOnce({
      code: "authentication",
      message: "Codex is not logged in.",
    });
  f.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(f.host);
  const props = {
    control,
    defaults: undefined,
    draft: {
      ...agentDraft(f.agent),
      command: "codex-acp",
      configuration: { mode: "default" as const },
    },
    capabilities: { modelDiscovery: "codex" as const },
    onChange: vi.fn(),
  };
  let view = render(<AgentModelPicker {...props} />);
  try {
    await screen.findByText(/Default model: old-account-model/);
    view.unmount();
    clock.mockReturnValue(61_000);
    view = render(<AgentModelPicker {...props} />);
    await screen.findByText("Codex is not logged in.");
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText(/Default model: old-account-model/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh models" }),
    ).toBeEnabled();
  } finally {
    view.unmount();
    control.dispose();
    clock.mockRestore();
  }
});
