// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentCreateProps,
  Agents,
  AgentCreationRequest,
  RegisteredAgentType,
} from "../../features/agents/service";
import { CreationReview } from "./CreationReview";

afterEach(cleanup);

type Config = { reply: string; model?: string };
const Create = ({ config, onChange }: AgentCreateProps<Config>) => (
  <textarea
    aria-label="Instructions"
    value={config.reply}
    onChange={(event) => onChange({ ...config, reply: event.target.value })}
  />
);

function fixture(proposed: Partial<AgentCreationRequest> = {}) {
  let requests: readonly AgentCreationRequest[] = [
    {
      id: "draft",
      requester: "a".repeat(64),
      requesterName: "Parent",
      owner: "b".repeat(64),
      community: "https://relay.example",
      type: "test/echo",
      name: "Child",
      ...proposed,
    },
  ];
  const listeners = new Set<() => void>();
  const clear = () => {
    requests = [];
    for (const listener of listeners) listener();
  };
  const kind = (key: string, title: string) => ({
    key,
    title,
    defaults: () => ({ config: { reply: "default" } }),
    adopt: ({ instructions }: { instructions?: string }, config: Config) => ({
      ...config,
      reply: instructions ?? config.reply,
    }),
    propose: (settings: { model?: string }, config: Config) => ({
      ...config,
      ...settings,
    }),
    carry: ({ reply }: Config) => (reply.trim() ? { instructions: reply } : {}),
    Create,
  });
  const types = [
    kind("test/echo", "Echo"),
    kind("test/other", "Other"),
  ] as unknown as readonly RegisteredAgentType[];
  const agents = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    types: () => types,
    creationRequests: () => requests,
    approveCreation: vi.fn(async () => {
      clear();
      return {} as Agent;
    }),
    dismissCreation: vi.fn(clear),
    create: vi.fn(),
  };
  render(<CreationReview agents={agents as unknown as Agents} />);
  return agents;
}

it("prefills an editable review and creates only when the owner submits", async () => {
  const user = userEvent.setup();
  const agents = fixture();
  const name = await screen.findByDisplayValue("Child");
  expect(
    screen.getByText(/Parent requested this agent\. Review/),
  ).toBeVisible();
  expect(agents.approveCreation).not.toHaveBeenCalled();
  await user.clear(name);
  await user.type(name, "Reviewed");
  await user.click(screen.getByRole("button", { name: /^Create agent$/ }));
  await waitFor(() =>
    expect(agents.approveCreation).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({
        name: "Reviewed",
        type: "test/echo",
        config: { reply: "default" },
      }),
    ),
  );
  expect(agents.create).not.toHaveBeenCalled();
});

it("dismisses an unsaved request when the owner closes its review", async () => {
  const user = userEvent.setup();
  const agents = fixture();
  await screen.findByDisplayValue("Child");
  await user.click(screen.getByRole("button", { name: /^Close$/ }));
  await waitFor(() =>
    expect(agents.dismissCreation).toHaveBeenCalledWith("draft"),
  );
  expect(agents.approveCreation).not.toHaveBeenCalled();
  expect(agents.create).not.toHaveBeenCalled();
});

it("starts the review from the proposed instructions and picture", async () => {
  const user = userEvent.setup();
  const picture = "https://example.test/child.png";
  const agents = fixture({ instructions: "Review PRs.", picture });
  expect(await screen.findByLabelText("Instructions")).toHaveValue(
    "Review PRs.",
  );
  await user.click(screen.getByRole("button", { name: /^Create agent$/ }));
  await waitFor(() =>
    expect(agents.approveCreation).toHaveBeenCalledWith("draft", {
      type: "test/echo",
      name: "Child",
      picture,
      config: { reply: "Review PRs." },
    }),
  );
});

it("keeps the owner's cleared instructions when they change the harness", async () => {
  const user = userEvent.setup();
  fixture({ instructions: "Review PRs." });
  const instructions = await screen.findByLabelText("Instructions");
  await user.clear(instructions);
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Other" }));
  expect(screen.getByLabelText("Instructions")).toHaveValue("default");
});

it("starts the proposed type from the proposed model, and another type from its own", async () => {
  const user = userEvent.setup();
  const agents = fixture({ settings: { model: "large" } });
  await screen.findByDisplayValue("Child");
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Other" }));
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Echo" }));
  await user.click(screen.getByRole("button", { name: /^Create agent$/ }));
  await waitFor(() =>
    expect(agents.approveCreation).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({
        type: "test/echo",
        config: { reply: "default", model: "large" },
      }),
    ),
  );
});
