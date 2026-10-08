import { expect, it, vi } from "vitest";
import type { AgentView, AgentControl } from "./control";
import type { RelaySession } from "../relay/session";
import { addChannelMember, startAddedAgent } from "../channel-members/members";
import { deployTeam, teamDeployment } from "./team-deployment";
vi.mock("../channel-members/members", () => ({
  addChannelMember: vi.fn(),
  startAddedAgent: vi.fn(),
}));
it("retries every saved member using the exact imported pubkeys without creating identities", async () => {
  const keys = ["a".repeat(64), "b".repeat(64)];
  const create = vi.fn();
  const control = {
    create,
    refresh: vi.fn(),
    snapshot: () => ({ data: { agents: [] } }),
  } as unknown as AgentControl;
  const session = {
    viewer: "b".repeat(64),
    scope: `https://relay.example:${"b".repeat(64)}`,
  } as RelaySession;
  const attempt = teamDeployment(
    { type: "team", id: "team", name: "Saved", agents: keys },
    "channel",
  );
  const signal = new AbortController().signal;
  vi.mocked(addChannelMember).mockRejectedValueOnce(
    new Error("first addition failed"),
  );
  await expect(deployTeam(control, session, attempt, signal)).rejects.toThrow(
    "first addition failed",
  );
  expect(addChannelMember).toHaveBeenCalledTimes(2);
  expect(startAddedAgent).toHaveBeenCalledExactlyOnceWith(
    control,
    session,
    "channel",
    keys[1],
    signal,
    true,
  );
  vi.mocked(addChannelMember).mockClear();
  vi.mocked(startAddedAgent).mockClear();
  await deployTeam(control, session, attempt, signal);
  for (const [index, pubkey] of keys.entries()) {
    expect(addChannelMember).toHaveBeenNthCalledWith(
      index + 1,
      session,
      "channel",
      pubkey,
      signal,
      attempt.additions[index],
    );
    expect(startAddedAgent).toHaveBeenNthCalledWith(
      index + 1,
      control,
      session,
      "channel",
      pubkey,
      signal,
      true,
    );
  }
  expect(create).not.toHaveBeenCalled();
});

it("adds an existing running member without writing team text or restarting it", async () => {
  vi.mocked(addChannelMember).mockClear();
  vi.mocked(startAddedAgent).mockClear();
  const agent = {
    id: "saved-copy",
    pubkey: "a".repeat(64),
    revision: 2,
    runningRevision: 1,
    status: "running",
    relayUrl: "wss://relay.example",
  } as AgentView;
  const applyTeamInstructions = vi.fn();
  const syncTeamInstructions = vi.fn();
  const action = vi.fn();
  const control = {
    refresh: vi.fn(),
    snapshot: () => ({ data: { agents: [agent] } }),
    applyTeamInstructions,
    syncTeamInstructions,
    action,
  } as unknown as AgentControl;
  const session = {
    viewer: "b".repeat(64),
    scope: `https://relay.example:${"b".repeat(64)}`,
  } as RelaySession;
  const signal = new AbortController().signal;
  await deployTeam(
    control,
    session,
    teamDeployment(
      { type: "team", id: "team", name: "Saved", agents: [agent.pubkey] },
      "channel",
    ),
    signal,
  );
  expect(addChannelMember).toHaveBeenCalledOnce();
  expect(startAddedAgent).toHaveBeenCalledExactlyOnceWith(
    control,
    session,
    "channel",
    agent.pubkey,
    signal,
    true,
  );
  expect(applyTeamInstructions).not.toHaveBeenCalled();
  expect(syncTeamInstructions).not.toHaveBeenCalled();
  expect(action).not.toHaveBeenCalled();
});
