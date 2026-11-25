// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Agents } from "../../features/agents/service";
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

it("saves a Custom selection that starts from the chosen role", async () => {
  const user = userEvent.setup();
  const agent = agentWith({
    model: "sonnet",
    instructions: "Keep these",
    toolDeny: "native:web",
  });
  const save = vi.fn(async () => {});
  const agents = {
    save,
    subscribe: () => () => {},
    tools: () => [
      {
        name: "tasks_update",
        description: "Update a Task",
        effect: "coordinate",
      },
    ],
  } as unknown as Agents;
  render(<AgentToolAccess agents={agents} agent={agent} />);

  await user.click(screen.getByRole("radio", { name: "Reviewer" }));
  expect(screen.getByRole("switch", { name: "Shell" })).not.toBeChecked();
  await user.click(screen.getByRole("radio", { name: "Custom" }));
  expect(screen.getByRole("switch", { name: "Files: read" })).toBeChecked();
  await user.click(screen.getByRole("switch", { name: "tasks_update" }));
  await user.type(
    screen.getByRole("textbox", { name: "Connected server or tool" }),
    "github{Enter}",
  );

  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledExactlyOnceWith(agent.key, {
    config: {
      model: "sonnet",
      instructions: "Keep these",
      toolPreset: "custom",
      toolAllow:
        "buzz:message,buzz:read,connected:github,native:meta,native:read,native:web,plugin:tasks_update",
    },
  });
});
