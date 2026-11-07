// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agents,
  TeamCreationRequest,
} from "../../features/agents/service";
import { TeamCreationReview } from "./TeamCreationReview";

const request: TeamCreationRequest = {
  id: "draft",
  requester: "a".repeat(64),
  requesterName: "Paul",
  owner: "o".repeat(64),
  community: "https://relay.example",
  name: "Crew",
  instructions: "Ship.",
  members: [
    { pubkey: "b".repeat(64), name: "Builder" },
    { pubkey: "c".repeat(64), name: "Checker" },
  ],
};

afterEach(cleanup);

function setup(approve = vi.fn(async () => ({}))) {
  let requests: readonly TeamCreationRequest[] = [request];
  const listeners = new Set<() => void>();
  const agents = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    teamCreationRequests: () => requests,
    dismissTeamCreation: vi.fn(() => {
      requests = [];
      for (const listener of listeners) listener();
    }),
    approveTeamCreation: approve,
  } as unknown as Agents;
  render(<TeamCreationReview agents={agents} />);
  return agents;
}

it("shows the proposed members and creates what the owner reviewed", async () => {
  const user = userEvent.setup();
  const agents = setup();
  expect(
    await screen.findByText(
      "Paul proposed this team. Nothing is created until you save.",
    ),
  ).toBeVisible();
  expect(screen.getByText("Builder")).toBeVisible();
  expect(screen.getByText("Checker")).toBeVisible();
  const name = screen.getByLabelText("Name");
  expect(name).toHaveValue("Crew");
  await user.clear(name);
  await user.type(name, "Squad ");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(agents.approveTeamCreation).toHaveBeenCalledWith("draft", {
    name: "Squad",
    instructions: "Ship.",
  });
});

it("shows a refused save and discards the request on close", async () => {
  const user = userEvent.setup();
  const agents = setup(
    vi.fn(async () => {
      throw new Error("A proposed member is no longer your agent there");
    }),
  );
  await user.click(await screen.findByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "no longer your agent",
  );
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(agents.dismissTeamCreation).toHaveBeenCalledWith("draft");
});
