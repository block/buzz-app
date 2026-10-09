import { expect, it, vi } from "vitest";
import type { AgentControl } from "./control";
import type { Communities } from "../communities/service";
import type { RelaySession } from "../relay/session";
import type { ChannelKit } from "../channel-templates/capability";
import type { KitEntry, Team } from "../channel-templates/model";
import {
  bindTeamTextSync,
  readTeamTexts,
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

it("can't certify a save when an overlapping team is unreadable", () => {
  expect(
    teamTextConflict([{ ...other(""), text: undefined }], team, "OURS"),
  ).toContain("can't be read");
});

const entry = (value: Team, deleted = false): KitEntry => ({
  eventId: `${value.id}-head`,
  createdAt: 1,
  record: {
    version: value.portable ? 2 : 1,
    community: "https://relay.example",
    deleted,
    value,
  },
});
const portable = {
  version: 1 as const,
  owner: "c".repeat(64),
  revision: "r",
  digest: "d".repeat(64),
  bytes: 1,
  chunks: 1,
};

it("reads each team's current text by precedence", async () => {
  const heads: Record<string, { text: string; head: string } | Error> = {
    head: { text: " HEAD \n", head: "h" },
    empty: { text: "", head: "h" },
    broken: new Error("chunk missing"),
  };
  const kit = {
    snapshot: () => ({
      entries: [
        entry({ type: "team", id: "head", name: "", agents: [a], portable }),
        entry({ type: "team", id: "empty", name: "", agents: [a], portable }),
        entry({ type: "team", id: "legacy", name: "", agents: [a], portable }),
        entry({ type: "team", id: "plain", name: "", agents: [a] }),
        entry({ type: "team", id: "broken", name: "", agents: [a], portable }),
        entry({ type: "team", id: "gone", name: "", agents: [a] }, true),
      ],
    }),
    readText: vi.fn(async (id: string) => {
      const head = heads[id];
      if (head instanceof Error) throw head;
      return head;
    }),
    loadTeam: vi.fn(async (value: Team) => value.id),
  } as unknown as ChannelKit;
  const control = {
    previewTeam: vi.fn(async () => ({ team: { instructions: "BUNDLE" } })),
  } as unknown as AgentControl;
  const texts = await readTeamTexts(kit, control);
  expect(
    Object.fromEntries(texts.map(({ team, text }) => [team.id, text])),
  ).toEqual({
    head: "HEAD",
    empty: "",
    legacy: "BUNDLE",
    plain: "",
    broken: undefined,
    gone: "",
  });
  // Only the team proven to have no head reads bundle text; a deleted team
  // releases its members without loading anything.
  expect(vi.mocked(kit.loadTeam).mock.calls.map(([t]) => t.id)).toEqual([
    "legacy",
  ]);
  expect(vi.mocked(kit.readText)).not.toHaveBeenCalledWith("gone");
  expect(texts.find(({ team }) => team.id === "gone")?.team.agents).toEqual([]);
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
  const channelList = { status: "loading" as string };
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
    channelKit: {
      subscribe,
      snapshot: () => kitState,
      ensure: vi.fn(),
      readText: vi.fn(async () => undefined),
    },
    channels: { subscribeList: subscribe, list: () => channelList },
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
  // The catalog read waits for channel discovery, then starts even when no
  // channel view is open (e.g. the app opened on Settings).
  expect(session.channelKit.ensure).not.toHaveBeenCalled();
  channelList.status = "ready";
  notify();
  expect(session.channelKit.ensure).toHaveBeenCalled();
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
