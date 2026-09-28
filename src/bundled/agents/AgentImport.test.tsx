// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentImport } from "./AgentImport";
import { controlFixture } from "../../features/agents/control-testing";
import { createAgentControl } from "../../features/agents/control";

afterEach(cleanup);
it("offers only explicit stopped-team completion for existing agents without starting or rewriting settings", async () => {
  const f = controlFixture();
  const agent = {
    ...f.agent,
    enabled: false,
    status: "stopped" as const,
    needsTeamImport: true,
  };
  const completed = {
    ...agent,
    revision: agent.revision + 1,
    needsTeamImport: false,
  };
  const commit = vi.fn(async () => ({ ...f.data, agents: [completed] }));
  const control = createAgentControl({
    ...f.host,
    previewImport: async () => ({
      token: "chosen-source",
      sourcePath: "/fixture/installed",
      warnings: [],
      candidates: [agent],
    }),
    commitImport: commit,
  });
  const onImported = vi.fn();
  const view = render(
    <AgentImport
      control={control}
      disabled={false}
      initialDestination={agent.relayUrl}
      managedAgents={[agent]}
      onImported={onImported}
    />,
  );
  try {
    const button = await screen.findByRole("button", {
      name: `Repair team import for ${agent.name}`,
    });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByText(/Both actions enable owner-visible Activity/),
    ).toBeTruthy();
    view.rerender(
      <AgentImport
        control={control}
        disabled={false}
        initialDestination={agent.relayUrl}
        managedAgents={[{ ...agent, enabled: true }]}
        onImported={onImported}
      />,
    );
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("Stop this agent before repairing its team import."),
    ).toBeTruthy();
    view.rerender(
      <AgentImport
        control={control}
        disabled={false}
        initialDestination={agent.relayUrl}
        managedAgents={[agent]}
        onImported={onImported}
      />,
    );
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        `Team instructions imported for ${agent.name}`,
      ),
    );
    expect(onImported).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith("chosen-source", [agent.id]);
    expect(f.calls.every((call) => call.action === "snapshot")).toBe(true);
  } finally {
    view.unmount();
    control.dispose();
  }
});
