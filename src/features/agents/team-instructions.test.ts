import { expect, it, vi } from "vitest";
import type { AgentControl } from "./control";
import type { Communities } from "../communities/service";
import type { RelaySession } from "../relay/session";
import {
  bindTeamTextSync,
  teamTextConflict,
  type TeamText,
} from "./team-instructions";

const a = "a".repeat(64);
const b = "b".repeat(64);
const other = (text: string, agents = [a]): TeamText => ({
  team: { type: "team", id: "other", name: "Reviewers", agents },
  text,
});
const team = { id: "mine", agents: [a] };

it("names the other team when a shared member would get different text", () => {
  expect(teamTextConflict([other("THEIRS")], team, "OURS")).toContain(
    '"Reviewers"',
  );
});

it.each([
  ["the saved team has no text", [other("THEIRS")], team, ""],
  ["the other team has no text", [other("")], team, "OURS"],
  ["the text matches after trimming", [other("OURS")], team, " OURS\n"],
  ["no member is shared", [other("THEIRS", [b])], team, "OURS"],
  [
    "the other entry is this team",
    [other("THEIRS")],
    { ...team, id: "other" },
    "OURS",
  ],
])("allows the save when %s", (_, others, saved, text) => {
  expect(teamTextConflict(others, saved, text)).toBeUndefined();
});

it("syncs team text once per session after teams and agents load", async () => {
  const viewer = "c".repeat(64);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const kitState = {
    status: "loading" as string,
    entries: [
      {
        eventId: "e",
        createdAt: 1,
        record: {
          version: 1,
          community: "https://relay.example",
          deleted: false,
          value: { type: "team", id: "plain", name: "Plain", agents: [a] },
        },
      },
    ],
  };
  const session = {
    viewer,
    scope: `https://relay.example:${viewer}`,
    channelKit: { subscribe, snapshot: () => kitState, ensure: vi.fn() },
  } as unknown as RelaySession;
  const controlState = { status: "loading" as string };
  const syncTeamInstructions = vi.fn(async () => ({}));
  const control = {
    subscribe,
    snapshot: () => controlState,
    syncTeamInstructions,
  } as unknown as AgentControl;
  const communities = {
    relay: { subscribe, snapshot: () => ({ status: "ready", session }) },
  } as unknown as Communities;
  const stop = bindTeamTextSync(control, communities);
  // Channel views start the catalog read after discovery; the sync only waits.
  expect(session.channelKit.ensure).not.toHaveBeenCalled();
  kitState.status = "ready";
  notify();
  expect(syncTeamInstructions).not.toHaveBeenCalled();
  controlState.status = "ready";
  notify();
  notify();
  await vi.waitFor(() =>
    expect(syncTeamInstructions).toHaveBeenCalledExactlyOnceWith(
      "https://relay.example",
      { plain: "" },
    ),
  );
  stop();
});
