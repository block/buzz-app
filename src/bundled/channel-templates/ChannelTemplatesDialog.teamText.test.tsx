// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentControl } from "../../features/agents/control";
import type { TeamSnapshot } from "../../features/agents/team-bundles";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type { KitEntry, Team } from "../../features/channel-templates/model";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ChannelTemplatesDialog } from "./ChannelTemplatesDialog";

vi.mock("../../features/profiles/AgentOwnerPreview", () => ({
  AgentOwnerPreview: () => null,
}));
afterEach(cleanup);
const viewer = "c".repeat(64);
const community = "https://relay.example.test";
const member = "a".repeat(64);
const second = "b".repeat(64);
const session = { viewer, scope: `${community}:${viewer}` } as RelaySession;
const memberSnapshot = {
  format: "buzz-agent-snapshot",
  version: 1,
  definition: { name: "Member", systemPrompt: "INDIVIDUAL" },
  profile: { displayName: "Member" },
  memory: { level: "none", entries: [] },
} as unknown as TeamSnapshot["members"][number];
const manifest = () => ({
  version: 1 as const,
  owner: viewer,
  revision: crypto.randomUUID(),
  digest: "d".repeat(64),
  bytes: 100,
  chunks: 1,
});
const ordinary: Team = {
  type: "team",
  id: "ordinary",
  name: "Ordinary",
  agents: [member],
};
const portable: Team = {
  type: "team",
  id: "portable",
  name: "Portable",
  agents: [member],
  portable: manifest(),
};
const entryOf = (team: Team): KitEntry => ({
  eventId: `${team.id}-head`,
  createdAt: 1,
  record: {
    version: team.portable ? 2 : 1,
    community,
    deleted: false,
    value: team,
  },
});
function setup(
  initial: Team,
  entries: KitEntry[],
  texts: Record<string, string>,
) {
  const snapshotOf = (team: Team): TeamSnapshot => ({
    format: "buzz-team-snapshot",
    version: 1,
    team: { name: team.name, instructions: texts[team.id] ?? "" },
    members: team.agents.map(() => structuredClone(memberSnapshot)),
  });
  const kitState = { status: "ready" as const, entries };
  const controlState = {
    data: {
      agents: [member, second].map((pubkey) => ({
        pubkey,
        relayUrl: "wss://relay.example.test",
      })),
    },
  };
  const save = vi.fn<ChannelKit["save"]>().mockResolvedValue("saved");
  const savePortable = vi
    .fn<ChannelKit["savePortable"]>()
    .mockResolvedValue("saved");
  const kit = {
    available: true,
    snapshot: () => kitState,
    subscribe: () => () => {},
    ensure: vi.fn(),
    refresh: vi.fn(),
    save,
    savePortable,
    loadTeam: vi.fn(async (team: Team) => team.id),
  } as unknown as ChannelKit;
  const captureTeam = vi.fn(async (_team: unknown, members: string[]) => ({
    format: "buzz-team-snapshot",
    version: 1,
    team: { name: initial.name },
    members: members.map(() => structuredClone(memberSnapshot)),
  }));
  const syncTeamInstructions = vi.fn(async () => controlState);
  const control = {
    syncTeamInstructions,
    previewTeam: vi.fn(async (id: string) => {
      const team = entries.find(
        (entry) => entry.record.value.id === JSON.parse(id),
      )?.record.value as Team;
      return snapshotOf(team);
    }),
    captureTeam,
    snapshot: () => controlState,
  } as unknown as AgentControl;
  render(
    <ChannelTemplatesDialog
      open
      onOpenChange={vi.fn()}
      kit={kit}
      initial={initial}
      expected={`${initial.id}-head`}
      active={() => true}
      session={session}
      control={control}
      agents={[
        { pubkey: member, name: "Member", avatar: undefined },
        { pubkey: second, name: "Second", avatar: undefined },
      ]}
    />,
    { wrapper: ToastProvider },
  );
  return { save, savePortable, captureTeam, syncTeamInstructions };
}
const instructions = () =>
  screen.findByRole("textbox", { name: "Team Instructions" });
const saveTeam = () =>
  userEvent.click(screen.getByRole("button", { name: "Save team" }));

it("adds team text to an existing ordinary team by converting it", async () => {
  const { save, savePortable, captureTeam } = setup(
    ordinary,
    [entryOf(ordinary)],
    {},
  );
  const field = await instructions();
  expect(field).toHaveValue("");
  await userEvent.type(field, "SHARED");
  await saveTeam();
  await waitFor(() => expect(savePortable).toHaveBeenCalledOnce());
  expect(captureTeam).toHaveBeenCalledOnce();
  expect(savePortable.mock.calls[0]?.[1].team.instructions).toBe("SHARED");
  expect(savePortable.mock.calls[0]?.[2]).toBe("ordinary-head");
  expect(save).not.toHaveBeenCalled();
});

it("keeps an ordinary team ordinary when no text is added", async () => {
  const { save, savePortable } = setup(ordinary, [entryOf(ordinary)], {});
  await instructions();
  await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "!");
  await saveTeam();
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(savePortable).not.toHaveBeenCalled();
});

it("shows the saved text and keeps it on a name-only edit", async () => {
  const { savePortable, syncTeamInstructions } = setup(
    portable,
    [entryOf(portable)],
    { portable: "SAVED" },
  );
  const field = await instructions();
  await waitFor(() => expect(field).toHaveValue("SAVED"));
  await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "!");
  await saveTeam();
  await waitFor(() => expect(savePortable).toHaveBeenCalledOnce());
  const [team, snapshot] = savePortable.mock.calls[0] ?? [];
  expect(team?.agents).toEqual([member]);
  expect(snapshot?.team.instructions).toBe("SAVED");
  expect(snapshot?.members).toHaveLength(1);
  await waitFor(() =>
    expect(syncTeamInstructions).toHaveBeenCalledExactlyOnceWith(community, {
      portable: "SAVED",
    }),
  );
});

it("saves an explicit clear as empty text", async () => {
  const { savePortable } = setup(portable, [entryOf(portable)], {
    portable: "SAVED",
  });
  const field = await instructions();
  await waitFor(() => expect(field).toHaveValue("SAVED"));
  await userEvent.clear(field);
  await saveTeam();
  await waitFor(() => expect(savePortable).toHaveBeenCalledOnce());
  expect(savePortable.mock.calls[0]?.[1].team.instructions).toBe("");
});

it("refuses a save that gives a member two different team texts", async () => {
  const other = { ...portable, id: "other", name: "Reviewers" };
  const { save, savePortable, syncTeamInstructions } = setup(
    ordinary,
    [entryOf(ordinary), entryOf(other)],
    { other: "THEIRS" },
  );
  await userEvent.type(await instructions(), "OURS");
  await saveTeam();
  expect(await screen.findByRole("alert")).toHaveTextContent('"Reviewers"');
  expect(savePortable).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(syncTeamInstructions).not.toHaveBeenCalled();
});

it.each([
  ["has no text", ""],
  ["has the same text", "OURS"],
])("allows sharing a member with a team that %s", async (_, text) => {
  const other = { ...portable, id: "other", name: "Reviewers" };
  const { savePortable } = setup(
    ordinary,
    [entryOf(ordinary), entryOf(other)],
    { other: text },
  );
  await userEvent.type(await instructions(), "OURS");
  await saveTeam();
  await waitFor(() => expect(savePortable).toHaveBeenCalledOnce());
});

it("keeps the saved text on a members-only edit", async () => {
  const { savePortable, captureTeam } = setup(portable, [entryOf(portable)], {
    portable: "SAVED",
  });
  const field = await instructions();
  await waitFor(() => expect(field).toHaveValue("SAVED"));
  await userEvent.click(screen.getByRole("checkbox", { name: /Second/ }));
  await saveTeam();
  await waitFor(() => expect(savePortable).toHaveBeenCalledOnce());
  const [team, snapshot] = savePortable.mock.calls[0] ?? [];
  expect(team?.agents).toEqual([member, second]);
  expect(snapshot?.team.instructions).toBe("SAVED");
  expect(captureTeam.mock.calls[0]?.[1]).toEqual([second]);
});

it("retries only the delivery after a save whose delivery failed", async () => {
  const { savePortable, syncTeamInstructions } = setup(
    portable,
    [entryOf(portable)],
    { portable: "SAVED" },
  );
  syncTeamInstructions.mockRejectedValueOnce(new Error("controller offline"));
  const field = await instructions();
  await waitFor(() => expect(field).toHaveValue("SAVED"));
  await saveTeam();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "controller offline",
  );
  await saveTeam();
  await waitFor(() => expect(syncTeamInstructions).toHaveBeenCalledTimes(2));
  expect(savePortable.mock.calls.map((call) => call[2])).toEqual([
    "portable-head",
    "saved",
  ]);
});
