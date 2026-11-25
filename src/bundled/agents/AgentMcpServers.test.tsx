// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, AgentType } from "../../features/agents/service";
import { AgentMcpServers } from "./AgentMcpServers";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));
afterEach(cleanup);

const agent = {
  key: "a",
  pubkey: "ab".repeat(32),
  owner: "cd".repeat(32),
  name: "Agent",
  type: "claude-code",
  relay: "wss://relay",
  place: "here",
  config: {},
} as unknown as Agent;

type Capability = NonNullable<AgentType["mcpServers"]>;
const OFFER =
  "Your Claude Code config changed since this agent started. Restart the agent to apply it.";

function show(
  inherited: Capability["inherited"],
  restartAgent: () => Promise<void> = async () => {},
  extra: Partial<Capability> = {},
) {
  render(
    <AgentMcpServers
      agents={{ approveMcp: vi.fn() }}
      agent={agent}
      capability={{
        transports: ["stdio", "http"],
        label: "Claude Code",
        ...(inherited ? { inherited } : {}),
        ...extra,
      }}
      restartAgent={restartAgent}
    />,
  );
}

const servers = [{ name: "github", source: "From your Claude Code config" }];

it("offers a restart when a running process started on another config", async () => {
  show(async () => ({ servers, changed: true }));
  expect(await screen.findByText(OFFER)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Restart agent" })).toBeVisible();
});

it("offers none when the config matches, or nothing runs", async () => {
  show(async () => ({ servers, changed: false }));
  await screen.findByText("github");
  expect(screen.queryByText(OFFER)).toBeNull();
  cleanup();
  show(async () => ({ servers }));
  await screen.findByText("github");
  expect(screen.queryByRole("button", { name: "Restart agent" })).toBeNull();
});

it("clears the offer after a restart, in place, and keeps it when the restart fails", async () => {
  const user = userEvent.setup();
  let running = true;
  const restartAgent = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("Couldn't stop it"))
    .mockImplementation(async () => {
      running = false;
    });
  show(async () => ({ servers, changed: running }), restartAgent);
  await user.click(
    await screen.findByRole("button", { name: "Restart agent" }),
  );
  await user.click(screen.getByRole("button", { name: "Restart" }));
  expect(await screen.findByText("Couldn't stop it")).toBeInTheDocument();
  expect(screen.getByText(OFFER)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Restart agent" }));
  await user.click(screen.getByRole("button", { name: "Restart" }));
  await waitFor(() => expect(screen.queryByText(OFFER)).toBeNull());
  expect(restartAgent).toHaveBeenCalledTimes(2);
});

it("keeps its state when the harness config can't be read", async () => {
  show(() => Promise.reject(new Error("unreadable")));
  await screen.findByText("No MCP servers yet");
  expect(screen.queryByText(OFFER)).toBeNull();
});

it("says how a harness that needs no restart picks up its config", async () => {
  show(async () => ({ servers: [] }), undefined, {
    label: "Codex",
    note: "Codex picks up changes to its own config on its next message.",
  });
  expect(
    await screen.findByText(
      "Codex picks up changes to its own config on its next message.",
    ),
  ).toBeInTheDocument();
});
