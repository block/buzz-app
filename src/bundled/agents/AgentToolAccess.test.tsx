// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Agents } from "../../features/agents/service";
import { AgentToolAccess } from "./AgentToolAccess";

afterEach(cleanup);

it("changes a role and saves only the tool fields with the rest of the config", async () => {
  const user = userEvent.setup();
  const agent = {
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
    owner: "f".repeat(64),
    name: "Ada",
    type: "buzz.claude-code/claude-code",
    place: "here",
    relay: "wss://example.com",
    config: { model: "sonnet", instructions: "Keep these" },
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: true,
  } satisfies Agent;
  const save = vi.fn(async () => {});
  const added: never[] = [];
  const agents = {
    save,
    subscribe: () => () => {},
    tools: () => added,
  } as unknown as Agents;
  render(<AgentToolAccess agents={agents} agent={agent} />);

  await user.click(screen.getByRole("combobox", { name: "Tool access role" }));
  await user.click(screen.getByRole("option", { name: /Chat only/ }));
  const effective = screen.getByText(/Effective access:/);
  expect(effective).toHaveTextContent("Effective access: 6 of");
  expect(effective).toHaveTextContent("1 of 7 native capability groups");
  await user.click(
    screen.getByRole("button", { name: "Advanced: Buzz tools" }),
  );
  expect(screen.getByText(/Enabled by the current draft:/)).toHaveTextContent(
    "send, reply_in_subthread, read, search, channel_list, channel_get",
  );

  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledExactlyOnceWith(agent.key, {
    config: {
      model: "sonnet",
      instructions: "Keep these",
      toolPreset: "chat",
      toolAllow: "",
      toolDeny: "",
    },
  });
});
