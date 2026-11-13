// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents,
  SessionUsage,
  UsageObservation,
} from "../../features/agents/service";
import { dayStart } from "../usage/stats";
import { CostRow } from "./CostRow";
import { weekCost } from "./cost";

afterEach(cleanup);

const NOW = new Date(2026, 10, 13, 15).getTime();
const agent = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  name: "Ada",
  type: "test/echo",
  place: "here",
} as unknown as Agent;
/** A request the harness recorded the cost of, `ago` days before NOW. */
const request = (ago: number, usd: number): UsageObservation => ({
  at: dayStart(NOW, ago) + 60_000,
  model: "test-model",
  tokens: {},
  cost: { usd, source: "recorded" },
});
const session = (
  id: string,
  observations: UsageObservation[],
): SessionUsage => ({
  id,
  revision: id,
  gaps: [],
  startedAt: Math.min(...observations.map((entry) => entry.at)),
  lastAt: Math.max(...observations.map((entry) => entry.at)),
  observations,
});
/** Agents whose type reads `usage`, or none when it is left out. */
const agentsWith = (usage?: unknown) =>
  ({
    types: () => [{ key: "test/echo", ...(usage ? { usage } : {}) }],
  }) as unknown as Pick<Agents, "types">;

it("adds the last seven days up and ignores older requests", async () => {
  const usage = vi.fn(async () => [
    session("one", [request(0, 0.25), request(2, 1.5)]),
    session("two", [request(6, 0.5), request(8, 40)]),
  ]);
  const week = await weekCost(
    agentsWith(usage),
    agent,
    new AbortController().signal,
    NOW,
  );
  expect(week.days).toHaveLength(7);
  expect(week.days.map((day) => day.cost.value)).toEqual([
    0.5, 0, 0, 0, 1.5, 0, 0.25,
  ]);
  expect(week.total).toEqual({ value: 2.25, partial: false });
  // Only the week is read, from the start of its first day.
  expect(usage).toHaveBeenCalledWith(agent, {
    since: dayStart(NOW, 6),
    signal: expect.any(AbortSignal),
  });
});

it("shows the total and a daily sparkline, and opens Usage", async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  render(
    <CostRow
      agents={agentsWith(async () => [
        session("one", [request(0, 0.25), request(1, 1.5)]),
      ])}
      agent={agent}
      open={open}
    />,
  );
  expect(await screen.findByText("$1.75")).toBeVisible();
  expect(screen.getByText("Cost, last 7 days")).toBeVisible();
  expect(screen.getByRole("img", { name: /Daily cost.*\$1\.50.*\$0\.25/ }));
  await user.click(screen.getByRole("button", { name: "Open Usage" }));
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "buzz.usage/usage",
  });
});

it("says so when the agent type reports no usage", () => {
  render(<CostRow agents={agentsWith()} agent={agent} open={vi.fn()} />);
  expect(
    screen.getByText(/this agent's type doesn't report its usage/),
  ).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
});

it("says so, without reading, for an agent that runs elsewhere", () => {
  const usage = vi.fn();
  render(
    <CostRow
      agents={agentsWith(usage)}
      agent={{ ...agent, place: "hosted" } as Agent}
      open={vi.fn()}
    />,
  );
  expect(screen.getByText(/this agent runs elsewhere/)).toBeVisible();
  expect(usage).not.toHaveBeenCalled();
});

it("shows a quiet error when the read rejects, and reads again on Retry", async () => {
  const user = userEvent.setup();
  const usage = vi
    .fn()
    .mockRejectedValueOnce(new Error("a transcript was too large"))
    .mockResolvedValue([session("one", [request(0, 0.4)])]);
  render(<CostRow agents={agentsWith(usage)} agent={agent} open={vi.fn()} />);
  expect(
    await screen.findByText("Couldn't read this agent's sessions."),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("$0.40")).toBeVisible();
  expect(usage).toHaveBeenCalledTimes(2);
});

it("stops reading when the tab closes", async () => {
  let signal: AbortSignal | undefined;
  const usage = vi.fn(
    (_: Agent, options: { signal: AbortSignal }) =>
      new Promise<SessionUsage[]>(() => {
        signal = options.signal;
      }),
  );
  const { unmount } = render(
    <CostRow agents={agentsWith(usage)} agent={agent} open={vi.fn()} />,
  );
  expect(screen.getByText("Reading its sessions…")).toBeVisible();
  await vi.waitFor(() => expect(signal).toBeDefined());
  unmount();
  expect(signal?.aborted).toBe(true);
});
