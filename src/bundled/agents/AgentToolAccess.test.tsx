// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Agents } from "../../features/agents/service";
import { nativeToolAllowed } from "../../features/agents/tool-access";
import { AgentToolAccess } from "./AgentToolAccess";

afterEach(cleanup);

const agentWith = (config: Record<string, unknown>) =>
  ({
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
    owner: "f".repeat(64),
    name: "Ada",
    type: "buzz.claude-code/claude-code",
    place: "here",
    relay: "wss://example.com",
    config,
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: true,
  }) satisfies Agent;

const agentsWith = (save = vi.fn(async () => {})) =>
  ({ save, subscribe: () => () => {}, tools: () => [] }) as unknown as Agents;

it("defaults to All and saves a chosen role without a selection", async () => {
  const user = userEvent.setup();
  const agent = agentWith({ model: "sonnet", toolDeny: "native:web" });
  const save = vi.fn(async () => {});
  render(<AgentToolAccess agents={agentsWith(save)} agent={agent} />);

  expect(screen.getByRole("radio", { name: "All" })).toBeChecked();
  expect(screen.getAllByRole("radio")).toHaveLength(3);
  await user.click(screen.getByRole("radio", { name: "Read Only" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledExactlyOnceWith(agent.key, {
    config: { model: "sonnet", toolPreset: "reviewer", toolAllow: "" },
  });
});

it("keeps an earlier saved selection until the owner chooses a role", async () => {
  const user = userEvent.setup();
  const config = { toolPreset: "custom", toolAllow: "buzz:read,native:read" };
  const save = vi.fn(async () => {});
  const { rerender } = render(
    <AgentToolAccess agents={agentsWith(save)} agent={agentWith(config)} />,
  );

  const earlier = screen.getByRole("radio", { name: "Earlier selection" });
  expect(earlier).toBeChecked();
  await user.click(screen.getByRole("radio", { name: "All" }));
  await user.click(earlier);
  expect(earlier).toBeChecked();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

  await user.click(screen.getByRole("radio", { name: "Read / Write" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledExactlyOnceWith(agentWith(config).key, {
    config: { toolPreset: "builder", toolAllow: "" },
  });
  rerender(
    <AgentToolAccess
      agents={agentsWith(save)}
      agent={agentWith({ toolPreset: "builder", toolAllow: "" })}
    />,
  );
  expect(
    screen.queryByRole("radio", { name: "Earlier selection" }),
  ).not.toBeInTheDocument();
});

it("reopens a saved Orchestrator as an earlier selection that still can't edit or run commands", () => {
  render(
    <AgentToolAccess
      agents={agentsWith()}
      agent={agentWith({ toolPreset: "super-agent" })}
    />,
  );
  expect(
    screen.getByRole("radio", { name: "Earlier selection" }),
  ).toBeChecked();
  expect(screen.getAllByRole("radio")).toHaveLength(4);
  expect(nativeToolAllowed("Edit", { toolPreset: "super-agent" })).toBe(false);
  expect(nativeToolAllowed("Bash", { toolPreset: "super-agent" })).toBe(false);
});
