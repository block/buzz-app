// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { controlFixture } from "../../features/agents/control-testing";
import {
  createAgentControl,
  type AiConfiguration,
} from "../../features/agents/control";
import { AgentQuickModel } from "./AgentQuickModel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it.each<AiConfiguration>([
  { mode: "default" },
  { mode: "advanced", effort: { kind: "value", value: "high" } },
])(
  "opens the full editor for Codex $mode without saving a partial configuration",
  async (configuration) => {
    const fixture = controlFixture();
    fixture.agent.harness.integration = "codex";
    fixture.agent.harness.configuration = configuration;
    const control = createAgentControl(fixture.host);
    const save = vi.spyOn(control, "save");
    const configure = vi.fn();
    const view = render(
      <AgentQuickModel
        agent={fixture.agent}
        control={control}
        state={{
          status: "ready",
          busy: false,
          error: null,
          data: fixture.data,
        }}
        onConfigure={configure}
      />,
    );
    try {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Configure Codex" }));
      expect(configure).toHaveBeenCalledOnce();
      expect(save).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      control.dispose();
    }
  },
);

it.each([
  ["BUZZ_AGENT_MODEL", null],
  ["GOOSE_MODEL", null],
  [null, "GOOSE_PROVIDER"],
])(
  "routes environment selectors %s / %s to the full editor",
  async (launchModelEnv, launchProviderEnv) => {
    const fixture = controlFixture();
    Object.assign(fixture.agent, {
      launchModelEnv,
      launchProviderEnv,
      status: "running",
      restartDiff: [],
    });
    const control = createAgentControl(fixture.host);
    const save = vi.spyOn(control, "save");
    const configure = vi.fn();
    const view = render(
      <AgentQuickModel
        agent={fixture.agent}
        control={control}
        state={{
          status: "ready",
          busy: false,
          error: null,
          data: fixture.data,
        }}
        onConfigure={configure}
      />,
    );
    try {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Configure model" }));
      expect(configure).toHaveBeenCalledOnce();
      expect(save).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      control.dispose();
    }
  },
);

it("mounted Pi cards discover only the opened picker", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const fixture = controlFixture();
  Object.assign(fixture.agent, { status: "running", restartDiff: [] });
  Object.assign(fixture.agent.harness, {
    command: "/local/buzz-pi-acp",
    integration: "pi",
    provider: "",
    model: "",
  });
  const run = vi.fn(async () => ({
    host: "",
    models: [{ id: "openai/model", name: "model" }],
    modelOverridden: false,
    disconnected: false,
  }));
  const begin = vi.fn(async () => 1);
  fixture.host.models = { begin, run, cancel: async () => {} };
  const control = createAgentControl(fixture.host);
  const view = render(
    ["one", "two"].map((id) => (
      <AgentQuickModel
        key={id}
        agent={{ ...fixture.agent, id }}
        control={control}
        state={{
          status: "ready",
          busy: false,
          error: null,
          data: fixture.data,
        }}
        onConfigure={() => {}}
      />
    )),
  );
  try {
    expect(begin).not.toHaveBeenCalled();
    await userEvent.setup().click(
      screen.getAllByRole("button", {
        name: "Browse models",
      })[0] as HTMLElement,
    );
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(begin).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    control.dispose();
  }
});
