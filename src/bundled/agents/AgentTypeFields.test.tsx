// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { RegisteredAgentType } from "../../features/agent-types/service";
import type { AgentView } from "../../features/agents/control";
import { agentEdit, type AgentDraft } from "./agent-edit";
import { AgentTypeFields, agentTypeError } from "./AgentTypeFields";

afterEach(cleanup);

const type = {
  id: "assistant",
  key: "example:assistant",
  pluginId: "example",
  revision: "one",
  title: "Assistant",
  Configure: () => null,
  subscription: () => ({}),
  run() {},
  secrets: [
    { name: "API_KEY", label: "Provider API key" },
    { name: "ORG", label: "Organisation", optional: true },
  ],
} as unknown as RegisteredAgentType;
const draft: AgentDraft = {
  revision: 1,
  name: "Helper",
  systemPrompt: "",
  sessionPolicy: null,
  workspace: "",
  command: "",
  args: "[]",
  model: "",
  provider: "",
  environment: {},
  plugin: { type: type.key, config: {} },
};
const saved = (environmentKeys: string[]) =>
  ({
    id: "a1",
    pubkey: "b".repeat(64),
    name: "Helper",
    harness: { environmentKeys },
  }) as unknown as AgentView;

function Form({
  agent,
  onDraft,
  context = false,
}: {
  agent?: AgentView;
  context?: boolean;
  onDraft(draft: AgentDraft): void;
}) {
  const [current, setCurrent] = useState(draft);
  return (
    <AgentTypeFields
      draft={current}
      types={[{ ...type, conversationContext: context }]}
      defaultSessionPolicy="thread"
      disabled={false}
      agent={agent}
      onChange={(patch) => {
        const next = { ...current, ...patch };
        setCurrent(next);
        onDraft(next);
      }}
    />
  );
}

it("asks for a type's secrets in write-only fields and saves only what was typed", async () => {
  const onDraft = vi.fn<(draft: AgentDraft) => void>();
  render(<Form onDraft={onDraft} />);
  const key = screen.getByLabelText("Provider API key");
  expect(key).toHaveAttribute("type", "password");
  expect(screen.getByLabelText("Organisation")).toHaveAttribute(
    "placeholder",
    "Optional",
  );
  expect(agentTypeError(draft, [type])).toBe("Enter Provider API key.");

  await userEvent.type(key, "sk-1");
  const typed = onDraft.mock.lastCall?.[0] as AgentDraft;
  expect(typed.environment).toEqual({ API_KEY: "sk-1" });
  expect(agentTypeError(typed, [type])).toBeUndefined();
  expect(agentEdit(typed)).toMatchObject({
    environment: { API_KEY: "sk-1" },
    plugin: { type: type.key },
  });
});

it("leaves a saved secret as it is unless a new value is typed", async () => {
  const onDraft = vi.fn<(draft: AgentDraft) => void>();
  render(<Form agent={saved(["API_KEY"])} onDraft={onDraft} />);
  const key = screen.getByLabelText("Provider API key");
  expect(key).toHaveValue("");
  expect(key).toHaveAttribute("placeholder", "Saved value unchanged");
  expect(agentTypeError(draft, [type], ["API_KEY"])).toBeUndefined();

  // Typing then clearing sends nothing, so native keeps the saved value.
  await userEvent.type(key, "x");
  await userEvent.clear(key);
  expect(onDraft.mock.lastCall?.[0].environment).toEqual({});
});

it("saves a plugin agent's conversation context using the existing agent setting", async () => {
  const user = userEvent.setup();
  const onDraft = vi.fn<(draft: AgentDraft) => void>();
  render(<Form context onDraft={onDraft} />);
  const select = screen.getByRole("combobox", { name: "Conversation context" });
  expect(select).toHaveTextContent("Use agent defaults (Each thread)");
  await user.click(select);
  await user.click(
    await screen.findByRole("option", { name: "Entire channel" }),
  );
  const changed = onDraft.mock.lastCall?.[0] as AgentDraft;
  expect(changed.sessionPolicy).toBe("channel");
  expect(agentEdit(changed).sessionPolicy).toBe("channel");
});
