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
import type { TeamManifest } from "../../features/channel-templates/team-payload";
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
const manifest = (revision: string = crypto.randomUUID()): TeamManifest => ({
  version: 1,
  owner: viewer,
  revision,
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
/** `texts` are team-text heads; `legacy` is v2 bundle text. A text of
 * `null` makes that team's head unreadable. */
function setup(
  initial: Team,
  entries: KitEntry[],
  texts: Record<string, string | null>,
  legacy: Record<string, string> = {},
) {
  const kitState = { status: "ready" as const, entries };
  const controlState = {
    data: {
      agents: [member, second].map((pubkey) => ({
        pubkey,
        relayUrl: "wss://relay.example.test",
      })),
    },
  };
  const save = vi.fn<ChannelKit["save"]>().mockResolvedValue("team-saved");
  const savePortable = vi.fn();
  const readText = vi.fn(async (id: string) => {
    const text = texts[id];
    if (text === null) throw new Error("chunk missing");
    return text === undefined ? undefined : { text, head: `${id}-text` };
  });
  const prepareText = vi.fn(
    async (_id: string, _text: string, revision: string) => manifest(revision),
  );
  const publishText = vi
    .fn<ChannelKit["publishText"]>()
    .mockResolvedValue("text-saved");
  const kit = {
    available: true,
    snapshot: () => kitState,
    subscribe: () => () => {},
    ensure: vi.fn(),
    refresh: vi.fn(),
    save,
    savePortable,
    readText,
    readTextHead: vi.fn(async (id: string) =>
      texts[id] === undefined ? undefined : { head: `${id}-text` },
    ),
    prepareText,
    publishText,
    loadTeam: vi.fn(async (team: Team) => team.id),
  } as unknown as ChannelKit;
  const syncTeamInstructions = vi.fn(async () => controlState);
  const control = {
    syncTeamInstructions,
    previewTeam: vi.fn(
      async (id: string): Promise<TeamSnapshot> => ({
        format: "buzz-team-snapshot",
        version: 1,
        team: { name: "", instructions: legacy[JSON.parse(id)] ?? "" },
        members: [],
      }),
    ),
    snapshot: () => controlState,
  } as unknown as AgentControl;
  render(
    <ChannelTemplatesDialog
      open
      onOpenChange={vi.fn()}
      kit={kit}
      initial={initial}
      expected={
        entries.some((e) => e.record.value.id === initial.id)
          ? `${initial.id}-head`
          : undefined
      }
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
  return {
    kitState,
    texts,
    save,
    savePortable,
    readText,
    prepareText,
    publishText,
    syncTeamInstructions,
  };
}
const instructions = () =>
  screen.findByRole("textbox", { name: "Team Instructions" });
const loaded = async (text: string) => {
  const field = await instructions();
  await waitFor(() => expect(field).toHaveValue(text));
  await waitFor(() => expect(field).toBeEnabled());
  return field;
};
const saveTeam = () =>
  userEvent.click(screen.getByRole("button", { name: "Save team" }));

it("shows the saved text head when the dialog reopens", async () => {
  setup(
    portable,
    [entryOf(portable)],
    { portable: "SAVED" },
    {
      portable: "OLD BUNDLE",
    },
  );
  await loaded("SAVED");
});

it("an empty text head wins over legacy bundle text", async () => {
  setup(
    portable,
    [entryOf(portable)],
    { portable: "" },
    {
      portable: "OLD BUNDLE",
    },
  );
  await loaded("");
});

it("shows legacy bundle text only when no text head exists", async () => {
  setup(portable, [entryOf(portable)], {}, { portable: "OLD BUNDLE" });
  await loaded("OLD BUNDLE");
});

it("refuses to edit when the text head can't be read, never falling back", async () => {
  const { save, publishText } = setup(
    portable,
    [entryOf(portable)],
    { portable: null },
    { portable: "OLD BUNDLE" },
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("chunk missing");
  expect(await instructions()).toHaveValue("");
  expect(screen.getByRole("button", { name: "Save team" })).toBeDisabled();
  expect(save).not.toHaveBeenCalled();
  expect(publishText).not.toHaveBeenCalled();
});

it("adds text to an ordinary team without converting or rewriting it", async () => {
  const { save, savePortable, prepareText, publishText, syncTeamInstructions } =
    setup(ordinary, [entryOf(ordinary)], {});
  await userEvent.type(await loaded(""), "SHARED");
  await saveTeam();
  await waitFor(() => expect(publishText).toHaveBeenCalledOnce());
  expect(prepareText.mock.calls[0]?.slice(0, 2)).toEqual([
    "ordinary",
    "SHARED",
  ]);
  expect(publishText.mock.calls[0]?.slice(0, 4)).toEqual([
    "ordinary",
    expect.objectContaining({ revision: prepareText.mock.calls[0]?.[2] }),
    undefined,
    "ordinary-head",
  ]);
  expect(save).not.toHaveBeenCalled();
  expect(savePortable).not.toHaveBeenCalled();
  await waitFor(() => expect(syncTeamInstructions).toHaveBeenCalledOnce());
});

it.each([
  ["an empty team", []],
  ["a mixed team of non-exportable members", [member, second]],
  [
    "a 200-member team",
    [
      member,
      ...Array.from({ length: 199 }, (_, i) =>
        i.toString(16).padStart(64, "0"),
      ),
    ],
  ],
])("saves text on %s", async (_, agents) => {
  const team = { ...ordinary, agents };
  const { save, publishText, savePortable } = setup(team, [entryOf(team)], {});
  await userEvent.type(await loaded(""), "SHARED");
  await saveTeam();
  await waitFor(() => expect(publishText).toHaveBeenCalledOnce());
  expect(save).not.toHaveBeenCalled();
  expect(savePortable).not.toHaveBeenCalled();
});

it("a name-only edit saves the team and leaves the text untouched", async () => {
  const { save, prepareText, publishText } = setup(
    portable,
    [entryOf(portable)],
    { portable: "SAVED" },
  );
  await loaded("SAVED");
  await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "!");
  await saveTeam();
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    name: "Portable!",
    agents: [member],
    portable: portable.portable,
  });
  expect(prepareText).not.toHaveBeenCalled();
  expect(publishText).not.toHaveBeenCalled();
});

it("a members-only edit keeps the saved text", async () => {
  const { save, publishText } = setup(ordinary, [entryOf(ordinary)], {
    ordinary: "SAVED",
  });
  await loaded("SAVED");
  await userEvent.click(screen.getByRole("checkbox", { name: /Second/ }));
  await saveTeam();
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]?.[0]).toMatchObject({ agents: [member, second] });
  expect(publishText).not.toHaveBeenCalled();
});

it("an explicit clear writes an empty text head over legacy text", async () => {
  const { prepareText, publishText } = setup(
    portable,
    [entryOf(portable)],
    {},
    { portable: "OLD BUNDLE" },
  );
  await userEvent.clear(await loaded("OLD BUNDLE"));
  await saveTeam();
  await waitFor(() => expect(publishText).toHaveBeenCalledOnce());
  expect(prepareText.mock.calls[0]?.[1]).toBe("");
});

it("saves members before text when both change", async () => {
  const { save, publishText } = setup(ordinary, [entryOf(ordinary)], {
    ordinary: "OLD",
  });
  const field = await loaded("OLD");
  await userEvent.click(screen.getByRole("checkbox", { name: /Second/ }));
  await userEvent.clear(field);
  await userEvent.type(field, "NEW");
  await saveTeam();
  await waitFor(() => expect(publishText).toHaveBeenCalledOnce());
  expect(save.mock.invocationCallOrder[0]).toBeLessThan(
    publishText.mock.invocationCallOrder[0] ?? 0,
  );
  expect(publishText.mock.calls[0]?.[2]).toBe("ordinary-text");
  expect(publishText.mock.calls[0]?.[3]).toBe("team-saved");
});

it("retries only the unfinished text write after a partial save", async () => {
  const { save, prepareText, publishText } = setup(
    ordinary,
    [entryOf(ordinary)],
    { ordinary: "OLD" },
  );
  publishText.mockRejectedValueOnce(new Error("relay offline"));
  const field = await loaded("OLD");
  await userEvent.click(screen.getByRole("checkbox", { name: /Second/ }));
  await userEvent.clear(field);
  await userEvent.type(field, "NEW");
  await saveTeam();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Members and name saved; instructions not saved: relay offline",
  );
  expect(field).toHaveValue("NEW");
  await saveTeam();
  await waitFor(() => expect(publishText).toHaveBeenCalledTimes(2));
  expect(save).toHaveBeenCalledOnce();
  expect(prepareText).toHaveBeenCalledOnce();
  expect(publishText.mock.calls[1]?.[1]).toBe(publishText.mock.calls[0]?.[1]);
  expect(publishText.mock.calls[1]?.[4]).toBe(publishText.mock.calls[0]?.[4]);
});

it("retries only the delivery after a save whose delivery failed", async () => {
  const { publishText, syncTeamInstructions } = setup(
    ordinary,
    [entryOf(ordinary)],
    {},
  );
  syncTeamInstructions.mockRejectedValueOnce(new Error("controller offline"));
  await userEvent.type(await loaded(""), "SHARED");
  await saveTeam();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Saved; members' instructions not updated",
  );
  await saveTeam();
  await waitFor(() => expect(syncTeamInstructions).toHaveBeenCalledTimes(2));
  expect(publishText).toHaveBeenCalledOnce();
});

it("refuses a save that gives a member two different team texts", async () => {
  const other = { ...ordinary, id: "other", name: "Reviewers" };
  const { save, publishText, syncTeamInstructions } = setup(
    ordinary,
    [entryOf(ordinary), entryOf(other)],
    { other: "THEIRS" },
  );
  await userEvent.type(await loaded(""), "OURS");
  await saveTeam();
  expect(await screen.findByRole("alert")).toHaveTextContent('"Reviewers"');
  expect(save).not.toHaveBeenCalled();
  expect(publishText).not.toHaveBeenCalled();
  expect(syncTeamInstructions).not.toHaveBeenCalled();
});

it("checks the in-between roster against the old text too", async () => {
  const other = {
    ...ordinary,
    id: "other",
    name: "Reviewers",
    agents: [second],
  };
  const { save } = setup(ordinary, [entryOf(ordinary), entryOf(other)], {
    ordinary: "OLD",
    other: "NEW",
  });
  const field = await loaded("OLD");
  await userEvent.click(screen.getByRole("checkbox", { name: /Second/ }));
  await userEvent.clear(field);
  await userEvent.type(field, "NEW");
  await saveTeam();
  expect(await screen.findByRole("alert")).toHaveTextContent('"Reviewers"');
  expect(save).not.toHaveBeenCalled();
});

it.each(["text", "members"] as const)(
  "a retry rechecks conflicts after another team's %s change",
  async (change) => {
    const other: Team = {
      ...ordinary,
      id: "other",
      name: "Reviewers",
      agents: change === "text" ? [member] : [second],
    };
    const f = setup(ordinary, [entryOf(ordinary), entryOf(other)], {
      ordinary: "OLD",
      other: change === "text" ? "NEW" : "OTHER",
    });
    f.publishText.mockRejectedValueOnce(new Error("relay offline"));
    const field = await loaded("OLD");
    await userEvent.clear(field);
    await userEvent.type(field, "NEW");
    await saveTeam();
    expect(await screen.findByRole("alert")).toHaveTextContent("relay offline");
    if (change === "text") f.texts.other = "DIFFERENT";
    else f.kitState.entries[1] = entryOf({ ...other, agents: [member] });
    await saveTeam();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      'also on "Reviewers", which has different team instructions',
    );
    expect(f.publishText).toHaveBeenCalledOnce();
  },
);

it("a combined save checks the text head before changing members", async () => {
  const f = setup(ordinary, [entryOf(ordinary)], { ordinary: "OLD" });
  const field = await loaded("OLD");
  await userEvent.click(screen.getByRole("checkbox", { name: /Second/ }));
  await userEvent.clear(field);
  await userEvent.type(field, "NEW");
  // Another device retired the text head after the dialog loaded it.
  delete f.texts.ordinary;
  await saveTeam();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "instructions changed",
  );
  expect(f.save).not.toHaveBeenCalled();
  expect(f.prepareText).not.toHaveBeenCalled();
});

it("can't certify a save when an overlapping team is unreadable", async () => {
  const other = { ...ordinary, id: "other", name: "Reviewers" };
  const { publishText } = setup(ordinary, [entryOf(ordinary), entryOf(other)], {
    other: null,
  });
  await userEvent.type(await loaded(""), "OURS");
  await saveTeam();
  expect(await screen.findByRole("alert")).toHaveTextContent("can't be read");
  expect(publishText).not.toHaveBeenCalled();
});

it.each([
  ["has no text", ""],
  ["has the same text", "OURS"],
])("allows sharing a member with a team that %s", async (_, text) => {
  const other = { ...ordinary, id: "other", name: "Reviewers" };
  const { publishText } = setup(ordinary, [entryOf(ordinary), entryOf(other)], {
    other: text,
  });
  await userEvent.type(await loaded(""), "OURS");
  await saveTeam();
  await waitFor(() => expect(publishText).toHaveBeenCalledOnce());
});

it("refuses to empty a team imported from a file", async () => {
  const { save } = setup(portable, [entryOf(portable)], { portable: "" });
  await loaded("");
  await userEvent.click(screen.getByRole("checkbox", { name: /Member/ }));
  await saveTeam();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "needs at least one member",
  );
  expect(save).not.toHaveBeenCalled();
});

it("has no Description field", async () => {
  setup(portable, [entryOf(portable)], { portable: "" });
  await loaded("");
  expect(
    screen.queryByRole("textbox", { name: "Description" }),
  ).not.toBeInTheDocument();
});
