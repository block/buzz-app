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
  invoke
    .mockResolvedValueOnce(stopped)
    .mockResolvedValueOnce({ ...stopped, state: "running" })
    .mockResolvedValueOnce(stopped);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Start agent" }));
  await screen.findByRole("button", { name: "Stop agent" });
  expect(invoke).toHaveBeenCalledWith("agent_runner_start", {
    viewer: "owner",
    community: "https://community.example",
  });
  fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
  await screen.findByRole("button", { name: "Start agent" });
  expect(invoke).toHaveBeenCalledWith("agent_runner_stop", {});
});
it("shows start failures without falsely reporting a running agent", async () => {
  invoke
    .mockResolvedValueOnce(stopped)
    .mockRejectedValueOnce(new Error("Stop old Buzz first"));
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
