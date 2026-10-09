// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
  PendingBetaTeam,
} from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";
import { BetaTeamSetup } from "./BetaTeamSetup";

const runner = vi.hoisted(() => ({ runBetaTeamStep: vi.fn() }));
vi.mock("../../features/agents/beta-team-import", () => runner);
afterEach(cleanup);

const viewer = "e".repeat(64);
const ready = { status: "ready", entries: [] };
const kit = { snapshot: () => ready };
const session = {
  scope: `https://relay.example.test:${viewer}`,
  viewer,
  channelKit: { ...kit, subscribe: () => () => {}, ensure: () => {} },
} as unknown as RelaySession;
const agent = (id: string, betaTeam: AgentView["betaTeam"]) =>
  ({
    id,
    pubkey: id.padEnd(64, "0"),
    revision: 1,
    relayUrl: "wss://relay.example.test",
    configured: true,
    betaTeam,
  }) as AgentView;
const team = (texts: string[]): PendingBetaTeam => ({
  teamId: "beta-1",
  name: "Writers",
  texts,
  members: [{ id: "a1", pubkey: "a1".padEnd(64, "0"), revision: 1 }],
});
const state = (agents: AgentView[]) =>
  ({
    status: "ready",
    busy: false,
    data: { agents },
  }) as unknown as AgentControlState;
const control = (overrides: Partial<AgentControl>) =>
  ({
    finishBetaTeam: vi.fn(),
    betaTeams: vi.fn(async () => []),
    ...overrides,
  }) as unknown as AgentControl;
const mount = (c: AgentControl, agents: AgentView[]) =>
  render(
    <BetaTeamSetup
      control={c}
      state={state(agents)}
      session={session}
      viewer={viewer}
    />,
  );

it("finishes a pending team with its only old Buzz text", async () => {
  runner.runBetaTeamStep
    .mockReset()
    .mockResolvedValue({ finished: ["a1"], failed: [] });
  const pending = team(["BETA"]);
  const c = control({ betaTeams: vi.fn(async () => [pending]) });
  mount(c, [
    agent("a1", { teamId: "beta-1", name: "Writers", status: "pending" }),
  ]);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Finish team setup for Writers",
    }),
  );
  await waitFor(() =>
    expect(runner.runBetaTeamStep).toHaveBeenCalledWith(
      session.channelKit,
      c,
      "https://relay.example.test",
      pending,
      { text: "BETA" },
    ),
  );
});

it("asks which text to keep when members disagreed and reports a failure", async () => {
  runner.runBetaTeamStep
    .mockReset()
    .mockResolvedValue({ finished: [], failed: ["refused"] });
  const c = control({ betaTeams: vi.fn(async () => [team(["ONE", "TWO"])]) });
  mount(c, [
    agent("a1", { teamId: "beta-1", name: "Writers", status: "pending" }),
  ]);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Finish team setup for Writers with instructions 2",
    }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("refused");
  expect(runner.runBetaTeamStep.mock.calls[0]?.[4]).toEqual({ text: "TWO" });
});

it("restores an earlier import's team, then finishes it", async () => {
  runner.runBetaTeamStep
    .mockReset()
    .mockResolvedValue({ finished: ["a1"], failed: [] });
  const pending = team(["BETA"]);
  const betaTeams = vi.fn(async () => [] as PendingBetaTeam[]);
  const restoreBetaTeam = vi.fn(async () => {
    betaTeams.mockResolvedValue([pending]);
    return {} as never;
  });
  const restoreBetaTeams = vi.fn(async () => ({
    token: "t",
    groups: [{ ...team(["BETA"]), inferred: true }],
  }));
  const c = control({ betaTeams, restoreBetaTeam, restoreBetaTeams });
  // Only agents without a recorded team are offered; "done" already has one.
  mount(c, [
    agent("a1", null),
    agent("done", { teamId: "beta-2", name: "X", status: "completed" }),
  ]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Find teams from old Buzz" }),
  );
  expect(restoreBetaTeams).toHaveBeenCalledWith("installed", ["a1"]);
  expect(await screen.findByText(/put together from/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Restore team Writers" }));
  await waitFor(() =>
    expect(runner.runBetaTeamStep).toHaveBeenCalledWith(
      session.channelKit,
      c,
      "https://relay.example.test",
      pending,
      { text: "BETA" },
    ),
  );
  expect(restoreBetaTeam).toHaveBeenCalledWith(
    "https://relay.example.test",
    "t",
    "beta-1",
    "BETA",
  );
});

it("shows nothing without pending teams or unrecorded imports", async () => {
  const betaTeams = vi.fn(async () => []);
  const view = mount(control({ betaTeams }), [
    agent("a1", { teamId: "beta-1", name: "W", status: "completed" }),
  ]);
  await waitFor(() => expect(betaTeams).toHaveBeenCalled());
  expect(view.container).toBeEmptyDOMElement();
});
