import { expect, it, vi } from "vitest";
import type { ChannelKit } from "../channel-templates/capability";
import type { KitEntry, Team } from "../channel-templates/model";
import type { AgentControl, PendingBetaTeam } from "./control";
import { betaTeamConflict, runBetaTeamStep } from "./beta-team-import";

const a = "a".repeat(64);
const b = "b".repeat(64);
const id = "beta-1";
const pending = (pubkeys = [a, b]): PendingBetaTeam => ({
  teamId: id,
  name: "Reviewers",
  texts: ["BETA"],
  members: pubkeys.map((pubkey, i) => ({
    id: `agent-${i}`,
    pubkey,
    revision: 1,
  })),
});
const manifest = {
  version: 1 as const,
  owner: "c".repeat(64),
  revision: "r",
  digest: "d".repeat(64),
  bytes: 1,
  chunks: 1,
};

/** A catalog with one entry per team and one text head per team. `text`
 * missing means no head; `null` is a tombstone. */
function fixture({
  teams = [] as (Team & { deleted?: boolean })[],
  heads = {} as Record<string, string | null>,
  portableText = "",
} = {}) {
  let events = 0;
  const entries = new Map<string, KitEntry>(
    teams.map(({ deleted = false, ...team }) => [
      team.id,
      {
        eventId: `head-${events++}`,
        createdAt: 1,
        record: { version: 1, community: "c", deleted, value: team },
      },
    ]),
  );
  const text = new Map(Object.entries(heads));
  const kit = {
    refresh: vi.fn(async () => {}),
    snapshot: () => ({ status: "ready", entries: [...entries.values()] }),
    readText: vi.fn(async (team: string) =>
      text.has(team)
        ? { text: text.get(team) ?? "", head: "text-head" }
        : undefined,
    ),
    loadTeam: vi.fn(async () => ({})),
    save: vi.fn(async (value: Team, expected: string | undefined) => {
      expect(expected).toBe(entries.get(value.id)?.eventId);
      const eventId = `head-${events++}`;
      entries.set(value.id, {
        eventId,
        createdAt: 1,
        record: { version: 1, community: "c", deleted: false, value },
      });
      return eventId;
    }),
    prepareText: vi.fn(async () => manifest),
    publishText: vi.fn(
      async (
        team: string,
        _m: unknown,
        expected: string | undefined,
        roster: string,
      ) => {
        expect(expected).toBeUndefined();
        expect(roster).toBe(entries.get(team)?.eventId);
        text.set(team, "BETA");
        return "text-head";
      },
    ),
  };
  const finished: Record<string, string> = {};
  const finishBetaTeam = vi.fn(
    async (
      _community: string,
      _texts: Record<string, string>,
      agent: string,
      _revision: number,
      outcome: "completed" | "skipped",
    ) => {
      const pubkey = agent === "agent-0" ? a : b;
      const listed = (
        entries.get(id)?.record.value as Team | undefined
      )?.agents.includes(pubkey);
      if ((outcome === "completed") !== !!listed)
        throw new Error(`${agent} not listed`);
      finished[agent] = outcome;
      return { agents: [] } as never;
    },
  );
  const control = {
    finishBetaTeam,
    previewTeam: vi.fn(async () => ({
      team: { name: "", instructions: portableText },
    })),
    snapshot: () => ({ data: { agents: [{ id: "agent-0", revision: 7 }] } }),
  } as unknown as AgentControl;
  return {
    kit: kit as unknown as ChannelKit,
    raw: kit,
    control,
    finishBetaTeam,
    finished,
    entries,
    text,
  };
}
const run = (f: ReturnType<typeof fixture>, team = pending()) =>
  runBetaTeamStep(f.kit, f.control, "wss://c", team, { text: "BETA" });
const roster = (f: ReturnType<typeof fixture>) =>
  (f.entries.get(id)?.record.value as Team | undefined)?.agents;

it("creates the team with its old Buzz text and finishes every member", async () => {
  const f = fixture();
  expect(await run(f)).toEqual({
    finished: ["agent-0", "agent-1"],
    failed: [],
  });
  expect(roster(f)).toEqual([a, b]);
  expect(f.text.get(id)).toBe("BETA");
  // The current revision wins over the listed one for an ordinary finish.
  expect(f.finishBetaTeam.mock.calls.map((c) => c[3])).toEqual([7, 1]);
});

it("reruns after the roster was saved but not the text without saving it again", async () => {
  const f = fixture({
    teams: [{ type: "team", id, name: "Reviewers", agents: [a, b] }],
  });
  await run(f);
  expect(f.raw.save).not.toHaveBeenCalled();
  expect(f.raw.publishText).toHaveBeenCalledOnce();
});

it("adds a later member to an existing team and keeps its saved text", async () => {
  const f = fixture({
    teams: [{ type: "team", id, name: "Renamed", agents: [a] }],
    heads: { [id]: "EDITED" },
  });
  await run(f, pending([b]));
  expect(f.raw.save).toHaveBeenCalledWith(
    { type: "team", id, name: "Renamed", agents: [a, b] },
    "head-0",
  );
  expect(f.raw.prepareText).not.toHaveBeenCalled();
  expect(f.text.get(id)).toBe("EDITED");
});

it.each([
  ["cleared to empty", { heads: { [id]: "" } }],
  ["with deleted instructions", { heads: { [id]: null } }],
  ["from a portable file with its own text", { portableText: "FROM FILE" }],
])("never refills a team %s", async (_, options) => {
  const f = fixture({
    teams: [
      {
        type: "team",
        id,
        name: "Reviewers",
        agents: [a, b],
        portable: manifest,
      },
    ],
    ...options,
  });
  await run(f);
  expect(f.raw.prepareText).not.toHaveBeenCalled();
  expect(f.raw.publishText).not.toHaveBeenCalled();
  expect(f.finished).toEqual({
    "agent-0": "completed",
    "agent-1": "completed",
  });
});

it("leaves a deleted team deleted and skips its members", async () => {
  const f = fixture({
    teams: [{ type: "team", id, name: "Reviewers", agents: [], deleted: true }],
  });
  await run(f);
  expect(f.raw.save).not.toHaveBeenCalled();
  expect(f.raw.publishText).not.toHaveBeenCalled();
  expect(f.finished).toEqual({ "agent-0": "skipped", "agent-1": "skipped" });
});

it("keeps a member removed before its finish pending", async () => {
  const f = fixture();
  f.raw.publishText.mockImplementationOnce(async () => {
    const team = f.entries.get(id)?.record.value as Team;
    team.agents = [a];
    return "text-head";
  });
  const outcome = await run(f);
  expect(outcome.finished).toEqual(["agent-0"]);
  expect(outcome.failed).toEqual(["agent-1 not listed"]);
  expect(f.finished).toEqual({ "agent-0": "completed" });
});

it("refuses before any write when a member would get two team texts", async () => {
  const f = fixture({
    teams: [{ type: "team", id: "other", name: "Writers", agents: [a] }],
    heads: { other: "OTHER" },
  });
  await expect(
    betaTeamConflict(f.kit, f.control, pending(), "BETA"),
  ).resolves.toContain('"Writers"');
  await expect(run(f)).rejects.toThrow('"Writers"');
  expect(f.raw.save).not.toHaveBeenCalled();
  expect(f.finishBetaTeam).not.toHaveBeenCalled();
});
