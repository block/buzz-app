// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRunner, useAgentRunner } from "./AgentRunner";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }));
afterEach(() => {
  cleanup();
  invoke.mockReset();
});
const stopped = {
  available: true,
  state: "stopped",
  name: "Moonpal",
  pubkey: "agent",
};
function Harness({ relay }: { relay: RelayData }) {
  return <AgentRunner controls={useAgentRunner(relay)} pubkeys={["agent"]} />;
}
function mount() {
  const state = {
    status: "ready",
    generation: 0,
    viewer: "owner",
    community: "https://community.example",
    session: {} as RelaySnapshot["session"],
  } as RelaySnapshot;
  return render(
    <Harness
      relay={
        {
          snapshot: () => state,
          subscribe: () => () => {},
          retry: () => {},
          disconnect: () => {},
          clearCache: async () => {},
        } as RelayData
      }
    />,
  );
}
it("starts in the selected scope and exposes stop after native success", async () => {
  let computeConnected = false;
  invoke.mockImplementation(async (command: string) => {
    if (command === "agent_runner_status") return stopped;
    if (command === "community_compute_status")
      return {
        available: true,
        state: computeConnected ? "running" : "off",
        generation: computeConnected ? 1 : 0,
        mode: computeConnected ? "client" : null,
        community: computeConnected ? "https://community.example" : null,
        viewer: computeConnected ? "owner" : null,
      };
    if (command === "community_compute_start") {
      computeConnected = true;
      return { state: "starting", mode: "client" };
    }
    if (command === "agent_runner_start")
      return { ...stopped, state: "running" };
    if (command === "agent_runner_stop") return stopped;
    throw new Error(`Unexpected command: ${command}`);
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Start agent" }));
  await screen.findByRole("button", { name: "Stop agent" });
  expect(invoke).toHaveBeenCalledWith("agent_runner_start", {
    viewer: "owner",
    community: "https://community.example",
  });
  expect(invoke).toHaveBeenCalledWith("community_compute_start", {
    request: {
      mode: "client",
      modelId: "remote",
      maxVramGb: null,
      community: "https://community.example",
      viewer: "owner",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
  await screen.findByRole("button", { name: "Start agent" });
  expect(invoke).toHaveBeenCalledWith("agent_runner_stop", {});
});
it("shows start failures without falsely reporting a running agent", async () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === "agent_runner_status") return stopped;
    if (command === "community_compute_status")
      return {
        available: true,
        state: "running",
        generation: 2,
        mode: "client",
        community: "https://community.example",
        viewer: "owner",
      };
    if (command === "agent_runner_start")
      throw new Error("Stop old Buzz first");
    throw new Error(`Unexpected command: ${command}`);
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Start agent" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Stop old Buzz first",
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start agent" })).toBeEnabled(),
  );
  expect(
    screen.queryByText("Runner started in this app"),
  ).not.toBeInTheDocument();
});

it("never places controls on a different identity with the same name", () => {
  render(
    <AgentRunner
      pubkeys={["other-agent"]}
      controls={{
        status: stopped,
        pending: false,
        error: undefined,
        canStart: true,
        run: vi.fn(),
      }}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Start agent" }),
  ).not.toBeInTheDocument();
});
