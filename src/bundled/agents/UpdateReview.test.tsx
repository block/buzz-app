// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agents,
  AgentUpdateRequest,
  RegisteredAgentType,
} from "../../features/agents/service";
import { UpdateReview } from "./UpdateReview";

afterEach(cleanup);

function fixture() {
  let requests: readonly AgentUpdateRequest[] = [
    {
      id: "draft",
      requester: "a".repeat(64),
      requesterName: "Parent",
      owner: "b".repeat(64),
      community: "https://relay.example",
      agent: "c".repeat(64),
      agentName: "Child",
      agentType: "test/echo",
      name: "Kid",
      instructions: "Review PRs.",
    },
  ];
  const listeners = new Set<() => void>();
  const clear = () => {
    requests = [];
    for (const listener of listeners) listener();
  };
  const types = [
    { key: "test/echo", title: "Echo" },
  ] as unknown as readonly RegisteredAgentType[];
  const agents = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    types: () => types,
    updateRequests: () => requests,
    approveUpdate: vi.fn(async () => clear()),
    dismissUpdate: vi.fn(clear),
    previewRetype: vi.fn(),
  };
  render(<UpdateReview agents={agents as unknown as Agents} />);
  return agents;
}

it("shows only the proposed changes and saves what the owner reviewed", async () => {
  const user = userEvent.setup();
  const agents = fixture();
  const name = await screen.findByDisplayValue("Kid");
  expect(
    screen.getByText(
      /Parent proposed these changes in https:\/\/relay.example/,
    ),
  ).toBeVisible();
  expect(screen.getByDisplayValue("Review PRs.")).toBeVisible();
  expect(screen.queryByText("Harness")).not.toBeInTheDocument();
  expect(agents.approveUpdate).not.toHaveBeenCalled();
  await user.clear(name);
  await user.type(name, "Reviewer");
  await user.click(screen.getByRole("button", { name: /^Save changes$/ }));
  await waitFor(() =>
    expect(agents.approveUpdate).toHaveBeenCalledWith("draft", {
      name: "Reviewer",
      instructions: "Review PRs.",
    }),
  );
});

it("discards an unsaved change request when the owner closes its review", async () => {
  const user = userEvent.setup();
  const agents = fixture();
  await screen.findByDisplayValue("Kid");
  await user.click(screen.getByRole("button", { name: /^Discard$/ }));
  await waitFor(() =>
    expect(agents.dismissUpdate).toHaveBeenCalledWith("draft"),
  );
  expect(agents.approveUpdate).not.toHaveBeenCalled();
});
