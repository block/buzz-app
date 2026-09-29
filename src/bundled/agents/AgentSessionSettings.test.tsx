// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSessionSettings } from "./AgentSessionSettings";
import { AgentEditor } from "./AgentEditor";
import { createAgentControl } from "../../features/agents/control";
import { createAgentActivity } from "../../features/agents/activity";
import { controlFixture } from "../../features/agents/control-testing";
import type { RelaySession } from "../../features/relay/session";

afterEach(cleanup);
it("wires the existing editor to observation only for Codex and releases it on harness change", async () => {
  const f = controlFixture();
  const control = createAgentControl(f.host);
  await control.refresh();
  const observe = vi.fn();
  const activity = createAgentActivity(true, observe, () => true);
  const session = { agentActivity: activity.queries } as RelaySession;
  const props = {
    control,
    session,
    state: control.snapshot(),
    onClose: vi.fn(),
  };
  const view = render(
    <AgentEditor
      {...props}
      agent={{
        ...f.agent,
        harness: { ...f.agent.harness, command: "/fixture/codex-acp" },
      }}
    />,
  );
  try {
    expect(
      screen.getByRole("region", { name: "Reported session settings" }),
    ).toBeVisible();
    expect(observe).toHaveBeenCalledWith(1);
    view.rerender(<AgentEditor {...props} agent={f.agent} />);
    expect(
      screen.queryByRole("region", { name: "Reported session settings" }),
    ).not.toBeInTheDocument();
    expect(observe).toHaveBeenLastCalledWith(null);
  } finally {
    view.unmount();
    control.dispose();
    activity.dispose();
  }
});
it("shows historical session values, not saved choices, and owns a cancellable observation lease", () => {
  const { agent } = controlFixture();
  const observe = vi.fn();
  const activity = createAgentActivity(true, observe, () => true);
  const session = { agentActivity: activity.queries } as RelaySession;
  const view = render(<AgentSessionSettings agent={agent} session={session} />);
  expect(observe).toHaveBeenCalledWith(1);
  expect(
    screen.getByText(/No session settings in retained activity/),
  ).toBeVisible();
  act(() => {
    activity.state({
      status: "connected",
      routes: [{ id: "observer", status: "live", replay: "unknown" }],
    });
    const event = (
      kind: string,
      seq: number,
      payload: object,
      sessionId: string | null = null,
    ) => ({
      kind,
      seq,
      payload,
      sessionId,
      turnId: "T",
      channelId: "C",
      agentIndex: 0,
      timestamp: new Date().toISOString(),
    });
    activity.receive(
      {
        id: "d".repeat(64),
        agent: agent.pubkey,
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind: "batch",
          payload: {
            events: [
              event("control_result", 1, {
                type: "switch_model",
                status: "unsupported_model",
                modelId: "requested",
                message: "SECRET",
              }),
              event("session_config_captured", 2, {
                relayUrl: agent.relayUrl,
                configOptions: [
                  { category: "model", currentValue: "observed-model" },
                ],
              }),
              event(
                "session_resolved",
                3,
                { sessionId: "S", isNewSession: true },
                "S",
              ),
            ],
          },
        }),
      },
      1,
    );
  });
  expect(screen.getByText("observed-model")).toBeVisible();
  expect(screen.getByText("Not reported")).toBeVisible();
  expect(
    screen.getByText(/Requested model requested was not supported/),
  ).toBeVisible();
  expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();
  view.rerender(
    <AgentSessionSettings
      agent={{
        ...agent,
        revision: agent.revision + 1,
        harness: { ...agent.harness, model: "new-saved-choice" },
      }}
      session={session}
    />,
  );
  expect(screen.getByText("observed-model")).toBeVisible();
  expect(screen.queryByText("new-saved-choice")).not.toBeInTheDocument();
  expect(
    screen.getByText(/not confirmation of the current launch/),
  ).toBeVisible();
  act(() => activity.clear());
  expect(screen.queryByText("observed-model")).not.toBeInTheDocument();
  view.unmount();
  expect(observe).toHaveBeenCalledWith(null);
  activity.dispose();
});
