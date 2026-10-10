// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { controlFixture } from "../../features/agents/control-testing";
import {
  createAgentControl,
  type AiConfiguration,
} from "../../features/agents/control";
import { AgentQuickModel } from "./AgentQuickModel";

afterEach(cleanup);
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
