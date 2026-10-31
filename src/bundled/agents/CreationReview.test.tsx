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

type Config = { reply: string };
const Create = ({ config, onChange }: AgentCreateProps<Config>) => (
  <textarea
    aria-label="Instructions"
    value={config.reply}
    onChange={(event) => onChange({ reply: event.target.value })}
  />
);

function fixture(instructions?: string) {
  let requests: readonly AgentCreationRequest[] = [
    {
      id: "draft",
      requester: "a".repeat(64),
      requesterName: "Parent",
      owner: "b".repeat(64),
      community: "https://relay.example",
      type: "test/echo",
      name: "Child",
      ...(instructions !== undefined && { instructions }),
    },
  ];
  const listeners = new Set<() => void>();
  const clear = () => {
    requests = [];
    for (const listener of listeners) listener();
  };
  const types = [
    {
      key: "test/echo",
      title: "Echo",
      defaults: () => ({ config: { reply: "default" } }),
      adopt: ({ instructions }: { instructions?: string }, config: Config) => ({
        reply: instructions ?? config.reply,
      }),
      Create,
    },
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

it("starts the review with the instructions the agent requested", async () => {
  const user = userEvent.setup();
  const agents = fixture("Review PRs.");
  await screen.findByDisplayValue("Child");
  expect(screen.getByLabelText("Instructions")).toHaveValue("Review PRs.");
  await user.click(screen.getByRole("button", { name: /^Create agent$/ }));
  await waitFor(() =>
    expect(agents.approveCreation).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({ config: { reply: "Review PRs." } }),
    ),
  );
});
