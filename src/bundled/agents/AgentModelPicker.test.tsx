// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentModelPicker } from "./AgentModelPicker";
import { agentDraft } from "./agent-edit";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";

afterEach(cleanup);

it("Goose Databricks v2 browses live IDs and flags an unlisted short name", async () => {
  const f = controlFixture();
  const run = vi.fn(async () => ({
    host: "",
    models: [
      {
        id: "data_workflow_tools.goose.goose-glm-5-3",
        name: "data_workflow_tools.goose.goose-glm-5-3",
      },
    ],
    modelOverridden: false,
    disconnected: false,
  }));
  f.host.models = {
    begin: async () => 1,
    run,
    cancel: async () => {},
  };
  const control = createAgentControl(f.host);
  const user = userEvent.setup();
  function Editor() {
    const [draft, setDraft] = useState({
      ...agentDraft(f.agent),
      command: "/usr/local/bin/goose",
      provider: "databricks_v2",
      model: "goose-glm-5-3",
    });
    return (
      <AgentModelPicker
        draft={draft}
        control={control}
        defaults={{ host: "", filter: "" }}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      />
    );
  }
  const view = render(<Editor />);
  try {
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await screen.findByText(/not in Goose’s current Databricks v2 list/);
    expect(run).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        host: "",
        filter: "",
        action: "connect",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model" })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    await user.click(
      screen.getByRole("option", {
        name: /data_workflow_tools\.goose\.goose-glm-5-3/,
      }),
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
      "data_workflow_tools.goose.goose-glm-5-3",
    );
    expect(
      screen.queryByText(/not in Goose’s current Databricks v2 list/),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    control.dispose();
  }
});

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

it("Pi discovers extension providers before start and selects the exact provider/model pair with one Browse", async () => {
  const f = controlFixture();
  let release!: (value: {
    host: string;
    models: { id: string; name: string }[];
    modelOverridden: boolean;
    disconnected: boolean;
  }) => void;
  const run = vi.fn(
    () =>
      new Promise<Parameters<typeof release>[0]>((resolve) => {
        release = resolve;
      }),
  );
  f.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const control = createAgentControl(f.host);
  const providers = vi.fn();
  const user = userEvent.setup();
  let current = {
    ...agentDraft(f.agent),
    command: "/local/buzz-pi-acp",
    args: "[]",
    provider: "",
    model: "saved-custom",
  };
  function Editor() {
    const [draft, setDraft] = useState(current);
    current = draft;
    return (
      <AgentModelPicker
        draft={draft}
        control={control}
        defaults={undefined}
        onPiProviders={providers}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      />
    );
  }
  const view = render(<Editor />);
  try {
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "Cancel model lookup", hidden: true }),
    ).toBeVisible();
    expect(
      await screen.findByRole("status", { name: "Model lookup" }),
    ).toHaveTextContent("Loading Pi models…");
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await act(async () =>
      release({
        host: "",
        models: [
          {
            id: "extension/namespace/model.v1",
            name: "extension/namespace/model.v1",
          },
        ],
        modelOverridden: false,
        disconnected: false,
      }),
    );
    await user.click(
      await screen.findByRole("option", {
        name: /extension\/namespace\/model.v1/,
      }),
    );
    expect(
      screen.queryByRole("status", { name: "Model lookup" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Model" })).not.toHaveAttribute(
      "aria-busy",
    );
    expect(current.provider).toBe("extension");
    expect(current.model).toBe("namespace/model.v1");
    expect(providers).toHaveBeenCalledWith(["extension"]);
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    expect(
      await screen.findByRole("option", {
        name: /extension\/namespace\/model.v1/,
      }),
    ).toBeVisible();
    expect(run).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("Pi cancellation and workspace changes reject late catalogs; explicit retry recovers", async () => {
  const f = controlFixture();
  let release!: (value: {
    host: string;
    models: { id: string; name: string }[];
    modelOverridden: boolean;
    disconnected: boolean;
  }) => void;
  const run = vi.fn(
    () =>
      new Promise<Parameters<typeof release>[0]>((resolve) => {
        release = resolve;
      }),
  );
  const cancel = vi.fn(async () => {});
  f.host.models = { begin: async () => 1, run, cancel };
  const control = createAgentControl(f.host);
  const user = userEvent.setup();
  let draft = {
    ...agentDraft(f.agent),
    command: "/local/buzz-pi-acp",
    args: "[]",
    provider: "custom",
    model: "kept",
  };
  const renderPicker = () => (
    <AgentModelPicker
      draft={draft}
      control={control}
      defaults={undefined}
      onChange={() => {}}
    />
  );
  const view = render(renderPicker());
  const result = {
    host: "",
    models: [{ id: "custom/new", name: "custom/new" }],
    modelOverridden: false,
    disconnected: false,
  };
  try {
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Model" })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", { name: "Cancel model lookup" }),
    );
    await act(async () => release(result));
    expect(cancel).toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue("kept");
    await user.click(screen.getByRole("button", { name: "Retry models" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    draft = { ...draft, workspace: "/different/workspace" };
    view.rerender(renderPicker());
    await act(async () => release(result));
    expect(
      screen.queryByRole("option", { name: /custom\/new/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    await act(async () => release(result));
    expect(
      await screen.findByRole("option", { name: /custom\/new/ }),
    ).toBeVisible();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("reopened Pi editor accepts a pasted qualified ID without doubling its provider", async () => {
  const control = createAgentControl(controlFixture().host);
  const user = userEvent.setup();
  let current = {
    ...agentDraft(controlFixture().agent),
    command: "/local/buzz-pi-acp",
    args: "[]",
    provider: "custom",
    model: "old",
  };
  function Editor() {
    const [draft, setDraft] = useState(current);
    current = draft;
    return (
      <AgentModelPicker
        draft={draft}
        control={control}
        defaults={undefined}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      />
    );
  }
  const view = render(<Editor />);
  try {
    const input = screen.getByRole("combobox", { name: "Model" });
    await user.clear(input);
    await user.type(input, "custom/namespace/model.v1");
    await user.tab();
    expect(current.model).toBe("namespace/model.v1");
    await user.clear(input);
    await user.type(input, "namespace/other.v2");
    await user.tab();
    expect(current.model).toBe("namespace/other.v2");
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("Pi warns about incomplete or unlisted selections and preserves literal Advanced IDs", async () => {
  const f = controlFixture();
  f.host.models = {
    begin: async () => 1,
    cancel: async () => {},
    run: async () => ({
      host: "",
      models: [{ id: "custom/listed", name: "custom/listed" }],
      modelOverridden: false,
      disconnected: false,
    }),
  };
  const control = createAgentControl(f.host);
  const user = userEvent.setup();
  let current = {
    ...agentDraft(f.agent),
    command: "/local/buzz-pi-acp",
    provider: "custom",
    model: "",
    args: "[]",
  };
  function Editor() {
    const [draft, setDraft] = useState(current);
    current = draft;
    return (
      <AgentModelPicker
        draft={draft}
        control={control}
        defaults={undefined}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      />
    );
  }
  const view = render(<Editor />);
  try {
    expect(
      screen.getByText(/Choose a model for this provider before starting/),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Model" }));
    const literal = screen.getByLabelText("Model ID (custom or blank)");
    await user.type(literal, "custom/");
    expect(literal).toHaveValue("custom/");
    await user.type(literal, "real-model");
    await user.tab();
    expect(current.model).toBe("custom/real-model");
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await screen.findByText(/This model ID is not in Pi’s available catalog/);
    expect(current.model).toBe("custom/real-model");
    await user.click(
      await screen.findByRole("option", { name: /custom\/listed/ }),
    );
    expect(current.model).toBe("listed");
    expect(
      screen.queryByText(/This model ID is not in Pi’s available catalog/),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("Pi clears discovered providers when catalog context changes or the picker unmounts", async () => {
  const f = controlFixture();
  const run = vi.fn(async () => ({
    host: "",
    models: [{ id: "extension/exact", name: "extension/exact" }],
    modelOverridden: false,
    disconnected: false,
  }));
  f.host.models = { begin: async () => 1, cancel: async () => {}, run };
  const control = createAgentControl(f.host),
    providers = vi.fn();
  const user = userEvent.setup();
  let draft = {
    ...agentDraft(f.agent),
    command: "/local/buzz-pi-acp",
    provider: "",
    model: "",
    args: "[]",
  };
  const picker = () => (
    <AgentModelPicker
      draft={draft}
      control={control}
      defaults={undefined}
      onPiProviders={providers}
      onChange={() => {}}
    />
  );
  const view = render(picker());
  try {
    for (const patch of [
      { workspace: "/new/workspace" },
      { environment: { PI_CODING_AGENT_DIR: "/new/config" } },
      { command: "buzz-agent" },
    ]) {
      await user.click(screen.getByRole("button", { name: "Browse models" }));
      await waitFor(() =>
        expect(providers).toHaveBeenLastCalledWith(["extension"]),
      );
      await screen.findByRole("option", { name: /extension\/exact/ });
      await user.keyboard("{Escape}");
      draft = { ...draft, ...patch };
      view.rerender(picker());
      await waitFor(() => expect(providers).toHaveBeenLastCalledWith([]));
    }
    view.unmount();
    expect(providers).toHaveBeenLastCalledWith([]);
  } finally {
    view.unmount();
    control.dispose();
  }
});
