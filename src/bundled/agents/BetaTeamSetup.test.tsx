// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
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
import { createAgentControl } from "../../features/agents/control";
import { useAgentControl } from "../../features/agents/control-react";
import { controlFixture } from "../../features/agents/control-testing";
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

it("finds again after an empty result, in the other library", async () => {
  const restoreBetaTeams = vi
    .fn()
    .mockResolvedValueOnce({ token: "t1", groups: [] })
    .mockResolvedValueOnce({ token: "t2", groups: [] })
    .mockResolvedValueOnce({
      token: "t3",
      groups: [{ ...team(["BETA"]), inferred: false }],
    });
  const c = control({ restoreBetaTeam: vi.fn(), restoreBetaTeams });
  mount(c, [agent("a1", null)]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Find teams from old Buzz" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(/No teams/);
  const again = screen.getByRole("button", { name: "Find teams again" });
  fireEvent.click(again);
  await waitFor(() => expect(restoreBetaTeams).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(again).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Old Buzz library"), {
    target: { value: "development" },
  });
  fireEvent.click(again);
  expect(
    await screen.findByRole("button", { name: "Restore team Writers" }),
  ).toBeVisible();
  expect(restoreBetaTeams).toHaveBeenLastCalledWith("development", ["a1"]);
});

it("re-previews after a refused restore, then restores with the new token", async () => {
  runner.runBetaTeamStep
    .mockReset()
    .mockResolvedValue({ finished: ["a1"], failed: [] });
  const restoreBetaTeam = vi
    .fn()
    .mockRejectedValueOnce(new Error("preview the restore again"))
    .mockResolvedValueOnce({});
  const restoreBetaTeams = vi
    .fn()
    .mockResolvedValueOnce({
      token: "old",
      groups: [{ ...team(["BETA"]), inferred: false }],
    })
    .mockResolvedValueOnce({
      token: "new",
      groups: [{ ...team(["BETA"]), inferred: false }],
    });
  const c = control({ restoreBetaTeam, restoreBetaTeams });
  mount(c, [agent("a1", null)]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Find teams from old Buzz" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Restore team Writers" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "preview the restore again",
  );
  const again = screen.getByRole("button", { name: "Find teams again" });
  await waitFor(() => expect(again).toHaveFocus());
  fireEvent.click(again);
  await waitFor(() => expect(restoreBetaTeams).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(again).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Restore team Writers" }));
  await waitFor(() =>
    expect(restoreBetaTeam).toHaveBeenLastCalledWith(
      "https://relay.example.test",
      "new",
      "beta-1",
      "BETA",
    ),
  );
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

const previewed = (token: string, texts = ["BETA"]) => ({
  token,
  groups: [{ ...team(texts), inferred: false }],
});

it("drops a found preview when the library changes", async () => {
  const restoreBetaTeams = vi.fn(async () => previewed("installed-token"));
  mount(control({ restoreBetaTeam: vi.fn(), restoreBetaTeams }), [
    agent("a1", null),
  ]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Find teams from old Buzz" }),
  );
  await screen.findByRole("button", { name: "Restore team Writers" });
  fireEvent.change(screen.getByLabelText("Old Buzz library"), {
    target: { value: "development" },
  });
  expect(
    screen.queryByRole("button", { name: "Restore team Writers" }),
  ).toBeNull();
});

it("offers no old Restore after finding again fails", async () => {
  const restoreBetaTeams = vi
    .fn()
    .mockResolvedValueOnce(previewed("old"))
    .mockRejectedValueOnce(new Error("Old Buzz library is unreadable."));
  mount(control({ restoreBetaTeam: vi.fn(), restoreBetaTeams }), [
    agent("a1", null),
  ]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Find teams from old Buzz" }),
  );
  await screen.findByRole("button", { name: "Restore team Writers" });
  fireEvent.click(screen.getByRole("button", { name: "Find teams again" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Old Buzz library is unreadable.",
  );
  expect(
    screen.queryByRole("button", { name: "Restore team Writers" }),
  ).toBeNull();
});

it("recovers a refused restore through the real agent control", async () => {
  runner.runBetaTeamStep
    .mockReset()
    .mockResolvedValue({ finished: ["fixture-agent"], failed: [] });
  const fixture = controlFixture();
  fixture.agent.betaTeam = null;
  const restoreBetaTeam = vi
    .fn()
    .mockRejectedValueOnce("Agent settings changed; preview the restore again")
    .mockImplementationOnce(async () => structuredClone(fixture.data));
  const restoreBetaTeams = vi
    .fn()
    .mockResolvedValueOnce(previewed("old"))
    .mockResolvedValueOnce(previewed("new"));
  const real = createAgentControl({
    ...fixture.host,
    betaTeams: async () => [],
    finishBetaTeam: vi.fn(),
    restoreBetaTeams,
    restoreBetaTeam,
  });
  await real.refresh();
  function Live() {
    return (
      <BetaTeamSetup
        control={real}
        state={useAgentControl(real)}
        session={session}
        viewer={viewer}
      />
    );
  }
  render(<Live />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Find teams from old Buzz" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Restore team Writers" }),
  );
  await waitFor(() => expect(real.snapshot().status).toBe("error"));
  await act(() => real.refresh());
  expect(real.snapshot().status).toBe("ready");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "preview the restore again",
  );
  const again = screen.getByRole("button", { name: "Find teams again" });
  await waitFor(() => expect(again).toHaveFocus());
  fireEvent.click(again);
  fireEvent.click(
    await screen.findByRole("button", { name: "Restore team Writers" }),
  );
  await waitFor(() =>
    expect(restoreBetaTeam).toHaveBeenLastCalledWith(
      "https://relay.example.test",
      "new",
      "beta-1",
      "BETA",
    ),
  );
  real.dispose();
});
