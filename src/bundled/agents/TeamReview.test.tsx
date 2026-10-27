// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Agents, TeamRequest } from "../../features/agents/service";
import { TeamReview } from "./TeamReview";

afterEach(cleanup);

const kid = "c".repeat(64);
const pal = "d".repeat(64);
const far = "e".repeat(64);
const saved = {
  id: "t1",
  name: "Crew",
  instructions: "Be kind.",
  members: [kid],
  revision: "head",
};

function fixture(change: Partial<TeamRequest> = {}) {
  let requests: readonly TeamRequest[] = [
    {
      id: "draft",
      requester: "a".repeat(64),
      requesterName: "Parent",
      owner: "b".repeat(64),
      community: "https://relay.example",
      name: "Crew",
      instructions: "Be kind.",
      members: [kid],
      ...change,
    },
  ];
  const listeners = new Set<() => void>();
  const clear = () => {
    requests = [];
    for (const listener of listeners) listener();
  };
  const snapshot = {
    running: [
      { pubkey: kid, name: "Kid", relay: "wss://relay.example" },
      { pubkey: pal, name: "Pal", relay: "wss://relay.example" },
      // Running in another community: Kid again, and Far only there.
      { pubkey: kid, name: "Kid", relay: "wss://other.example" },
      { pubkey: far, name: "Far", relay: "wss://other.example" },
    ] as unknown as readonly Agent[],
    teams: [saved],
  };
  const agents = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    memberships: (pubkey: string) =>
      snapshot.running.filter((agent) => agent.pubkey === pubkey),
    teamRequests: () => requests,
    approveTeam: vi.fn(async () => clear()),
    dismissTeam: vi.fn(clear),
  };
  render(<TeamReview agents={agents as unknown as Agents} />);
  return agents;
}

it("shows the proposed team and saves what the owner reviewed", async () => {
  const user = userEvent.setup();
  const agents = fixture();
  const name = await screen.findByDisplayValue("Crew");
  expect(screen.getByText("New team")).toBeVisible();
  expect(screen.getByText(/Parent requested this team\./)).toBeVisible();
  expect(screen.getByLabelText("Instructions")).toHaveValue("Be kind.");
  expect(screen.getByRole("checkbox", { name: "Kid" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Pal" })).not.toBeChecked();
  expect(agents.approveTeam).not.toHaveBeenCalled();
  await user.clear(name);
  await user.type(name, "Reviewed");
  await user.click(screen.getByRole("checkbox", { name: "Pal" }));
  await user.click(screen.getByRole("button", { name: /^Create team$/ }));
  await waitFor(() =>
    expect(agents.approveTeam).toHaveBeenCalledWith("draft", {
      name: "Reviewed",
      instructions: "Be kind.",
      members: [kid, pal],
      // The same new team every retry.
      draft: expect.any(String),
    }),
  );
});

it("reviews a change to a saved team under its current name", async () => {
  const user = userEvent.setup();
  const agents = fixture({
    team: "t1",
    teamName: "Old crew",
    instructions: "Be brief.",
  });
  const name = await screen.findByDisplayValue("Crew");
  expect(screen.getByText("Edit Old crew")).toBeVisible();
  expect(screen.getByText(/Parent proposed these changes\./)).toBeVisible();
  await user.clear(name);
  await user.type(name, "Crew mates");
  expect(screen.getByText("Edit Old crew")).toBeVisible();
  await user.click(screen.getByRole("button", { name: /^Save team$/ }));
  await waitFor(() =>
    expect(agents.approveTeam).toHaveBeenCalledWith("draft", {
      name: "Crew mates",
      instructions: "Be brief.",
      members: [kid],
      // The base a synced Save revises.
      opened: saved,
    }),
  );
});

it("dismisses an unsaved request when the owner closes its review", async () => {
  const user = userEvent.setup();
  const agents = fixture();
  await screen.findByDisplayValue("Crew");
  await user.click(screen.getByRole("button", { name: /^Close$/ }));
  await waitFor(() => expect(agents.dismissTeam).toHaveBeenCalledWith("draft"));
  expect(agents.approveTeam).not.toHaveBeenCalled();
});

it("lists the request's community's agents and counts members elsewhere", async () => {
  fixture({ members: [kid, far] });
  await screen.findByDisplayValue("Crew");
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  expect(screen.getByRole("checkbox", { name: "Kid" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Pal" })).not.toBeChecked();
  expect(screen.queryByRole("checkbox", { name: "Far" })).toBeNull();
  expect(
    screen.getByText("+1 in your other communities, who stay on the team."),
  ).toBeVisible();
});
