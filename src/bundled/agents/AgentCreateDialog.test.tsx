// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useSyncExternalStore } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentCreateDialog } from "./AgentCreateDialog";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import type { ModelCatalog } from "../../features/agents/models";

afterEach(cleanup);
const catalog: ModelCatalog = {
  integration: { kind: "databricks", host: "https://workspace.example" },
  discovery: {
    source: "databricksCatalog",
    authentication: "authenticated",
    catalog: "remote",
  },
  models: [
    { id: "endpoint", name: "Model label", effort: { status: "unsupported" } },
  ],
  modelOverridden: false,
  disconnected: false,
};

it("requires current discovery in Advanced, invalidates context changes, and retains rejected drafts", async () => {
  const f = controlFixture();
  f.data.createAvailable = true;
  f.data.defaultWorkspace = "/fixture/workspace";
  f.data.databricksDefaults = { host: "https://workspace.example", filter: "" };
  let release!: (value: ModelCatalog) => void;
  const response = new Promise<ModelCatalog>((resolve) => {
    release = resolve;
  });
  const run = vi.fn(() => response);
  f.host.models = { begin: async () => 1, run, cancel: async () => {} };
  const prepare = vi.fn().mockRejectedValue({
    code: "authentication",
    message: "Sign-in required. Refresh models.",
  });
  f.host.prepareCreate = prepare;
  f.host.commitCreate = vi.fn();
  const control = createAgentControl(f.host);
  await control.refresh();
  function Example() {
    const state = useSyncExternalStore(control.subscribe, control.snapshot);
    return (
      <AgentCreateDialog
        control={control}
        state={state}
        destination="wss://relay.example"
        owner={"ab".repeat(32)}
        onClose={() => {}}
      />
    );
  }
  render(<Example />);
  const user = userEvent.setup();
  try {
    await user.type(screen.getByLabelText("Name"), "Test agent");
    const create = screen.getByRole("button", { name: "Create agent" });
    expect(create).toBeEnabled();
    expect(run).not.toHaveBeenCalled();
    await user.click(screen.getByRole("combobox", { name: "Configuration" }));
    await user.click(await screen.findByRole("option", { name: "Advanced" }));
    expect(create).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(create).toBeDisabled();
    await act(async () => release(catalog));
    await user.click(
      await screen.findByRole("option", { name: /^Model label/ }),
    );
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Environment" }));
    fireEvent.change(screen.getByLabelText("Workspace"), {
      target: { value: "/different" },
    });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Workspace"), {
      target: { value: "/fixture/workspace" },
    });
    expect(create).toBeDisabled(); // returning to an old context cannot revive evidence
    await user.click(screen.getByRole("button", { name: "Browse models" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await user.click(
      await screen.findByRole("option", { name: /^Model label/ }),
    );
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);
    await screen.findByText("Sign-in required. Refresh models.");
    expect(create).toBeDisabled();
    expect(screen.getByLabelText("Name")).toHaveValue("Test agent");
    expect(control.snapshot().status).toBe("ready");
    expect(f.host.commitCreate).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledWith(
      expect.any(String),
      "wss://relay.example",
      "ab".repeat(32),
      expect.objectContaining({
        harness: expect.objectContaining({
          model: "endpoint",
          configuration: { mode: "advanced", effort: { kind: "unsupported" } },
        }),
      }),
    );
    fireEvent.change(screen.getByLabelText("Workspace"), {
      target: { value: "/different" },
    });
    expect(create).toBeDisabled();
    // Submit via Enter/programmatic form dispatch has the same guard.
    const form = create.closest("form");
    if (!form) throw new Error("Missing creation form");
    fireEvent.submit(form);
    expect(prepare).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("combobox", { name: "Configuration" }));
    await user.click(
      await screen.findByRole("option", { name: "Harness defaults" }),
    );
    expect(create).toBeEnabled();
    await user.click(create);
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    expect(prepare.mock.calls[1]?.[3].harness).toMatchObject({
      model: "",
      configuration: { mode: "default" },
    });
  } finally {
    control.dispose();
  }
});

it("does not create with an older host that cannot validate explicit modes", async () => {
  const f = controlFixture();
  f.data.createAvailable = true;
  delete f.data.configurationAvailable;
  const prepare = vi.fn();
  f.host.prepareCreate = prepare;
  f.host.commitCreate = vi.fn();
  const control = createAgentControl(f.host);
  await control.refresh();
  render(
    <AgentCreateDialog
      control={control}
      state={control.snapshot()}
      destination="wss://relay.example"
      owner={"ab".repeat(32)}
      onClose={() => {}}
    />,
  );
  expect(screen.queryByRole("combobox", { name: "Configuration" })).toBeNull();
  expect(screen.getByRole("button", { name: "Create agent" })).toBeDisabled();
  expect(prepare).not.toHaveBeenCalled();
  control.dispose();
});
