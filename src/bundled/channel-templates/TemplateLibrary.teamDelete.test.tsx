// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentControl } from "../../features/agents/control";
import type { TeamSnapshot } from "../../features/agents/team-bundles";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type { KitEntry, Team } from "../../features/channel-templates/model";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { TemplateLibrary } from "./TemplateLibrary";

afterEach(cleanup);
const viewer = "c".repeat(64);
const community = "https://relay.example.test";
const member = "a".repeat(64);
const portableTeam = (id: string, name: string): Team => ({
  type: "team",
  id,
  name,
  agents: [member],
  portable: {
    version: 1,
    owner: viewer,
    revision: crypto.randomUUID(),
    digest: "d".repeat(64),
    bytes: 100,
    chunks: 1,
  },
});
const entryOf = (team: Team, deleted = false): KitEntry => ({
  eventId: `${team.id}-${deleted ? "tombstone" : "head"}`,
  createdAt: deleted ? 2 : 1,
  record: { version: 2, community, deleted, value: team },
});

function renderLibrary(
  kit: ChannelKit,
  state: { status: "ready"; entries: KitEntry[] },
  control: object,
) {
  render(
    <TemplateLibrary
      section="team"
      kit={kit}
      active={() => true}
      catalog={{
        kit: state,
        agents: [
          { pubkey: member, name: "Member", managed: false, avatar: undefined },
        ],
        agentsReady: true,
        agentsComplete: true,
        agentsPending: false,
        error: undefined,
        refresh: vi.fn(),
      }}
      control={control as unknown as AgentControl}
      session={
        {
          viewer,
          scope: `${community}:${viewer}`,
          communityCatalog: { available: () => false },
        } as unknown as RelaySession
      }
    />,
    { wrapper: ToastProvider },
  );
}
async function openDelete(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Actions for Crew" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete team…" }),
  );
  const confirmation = screen.getByRole("dialog", { name: "Delete “Crew”?" });
  return within(confirmation).getByRole("button", { name: "Delete" });
}

it("deleting a team retires its text head and releases only that team; a retry repeats only unfinished phases", async () => {
  const user = userEvent.setup();
  const crew = portableTeam("crew", "Crew");
  const pair = portableTeam("pair", "Pair");
  const state = {
    status: "ready" as const,
    entries: [entryOf(crew), entryOf(pair)],
  };
  // Like the real kit, a confirmed delete refreshes to the selected tombstone.
  const save = vi.fn<ChannelKit["save"]>(async (value, _expected, deleted) => {
    state.entries = state.entries.map((entry) =>
      entry.record.value.id === value.id
        ? entryOf(value as Team, deleted)
        : entry,
    );
    return "tombstone";
  });
  const loadTeam = vi.fn(async (team: Team) => team.id);
  // Crew has a text head whose chunks are gone; deletion still retires it.
  const readText = vi.fn(async (id: string) => {
    if (id === "crew") throw new Error("chunk missing");
    return undefined;
  });
  const readTextHead = vi.fn(async (id: string) =>
    id === "crew" ? { head: "crew-text", deleted: false } : undefined,
  );
  const publishText = vi
    .fn<ChannelKit["publishText"]>()
    .mockRejectedValueOnce(new Error("relay offline"))
    .mockResolvedValue("crew-text-tombstone");
  const kit = {
    available: true,
    snapshot: () => state,
    subscribe: () => () => {},
    ensure: vi.fn(),
    refresh: vi.fn(),
    save,
    loadTeam,
    readText,
    readTextHead,
    publishText,
  } as unknown as ChannelKit;
  const syncTeamInstructions = vi
    .fn(async () => ({}))
    .mockRejectedValueOnce(new Error("controller offline"));
  const previewTeam = vi.fn(
    async (): Promise<TeamSnapshot> => ({
      format: "buzz-team-snapshot",
      version: 1,
      team: { name: "Team", instructions: "SHARED" },
      members: [],
    }),
  );
  renderLibrary(kit, state, { syncTeamInstructions, previewTeam });
  const remove = await openDelete(user);
  await user.click(remove);
  // Text cleanup failed and so did delivery, which still ran.
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Team deleted; instructions cleanup or member update pending",
  );
  expect(syncTeamInstructions).toHaveBeenCalledTimes(1);
  await user.click(remove);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(save).toHaveBeenCalledExactlyOnceWith(
    crew,
    "crew-head",
    true,
    undefined,
    expect.anything(),
  );
  expect(publishText).toHaveBeenCalledTimes(2);
  for (const call of publishText.mock.calls)
    expect(call.slice(0, 4)).toEqual(["crew", null, "crew-text", undefined]);
  // The deleted team goes out as empty text without loading its payload;
  // the surviving team keeps its text.
  expect(syncTeamInstructions).toHaveBeenCalledTimes(2);
  for (const call of syncTeamInstructions.mock.calls)
    expect(call).toEqual([community, { crew: "", pair: "SHARED" }]);
  expect(loadTeam.mock.calls.map(([team]) => team.id)).toEqual([
    "pair",
    "pair",
  ]);
});

it("a retry after a lost tombstone confirmation confirms that same tombstone, then cleans up", async () => {
  const user = userEvent.setup();
  const crew = portableTeam("crew", "Crew");
  const state = { status: "ready" as const, entries: [entryOf(crew)] };
  // The first attempt enqueues the tombstone, then loses its confirmation.
  const save = vi.fn<ChannelKit["save"]>(
    async (value, _expected, deleted, _signal, resume) => {
      if (!resume?.id) {
        resume?.enqueued("tombstone");
        throw new Error("Save is awaiting exact relay confirmation");
      }
      state.entries = [entryOf(value as Team, deleted)];
      return resume.id;
    },
  );
  const publishText = vi
    .fn<ChannelKit["publishText"]>()
    .mockResolvedValue("crew-text-tombstone");
  const kit = {
    available: true,
    snapshot: () => state,
    subscribe: () => () => {},
    ensure: vi.fn(),
    refresh: vi.fn(),
    save,
    loadTeam: vi.fn(),
    readText: vi.fn(),
    readTextHead: vi.fn(async () => ({ head: "crew-text", deleted: false })),
    publishText,
  } as unknown as ChannelKit;
  const syncTeamInstructions = vi.fn(async () => ({}));
  renderLibrary(kit, state, { syncTeamInstructions });
  const remove = await openDelete(user);
  await user.click(remove);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "awaiting exact relay confirmation",
  );
  expect(publishText).not.toHaveBeenCalled();
  await user.click(remove);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  // The retry passed the same resume record, so it confirmed the enqueued
  // tombstone rather than writing against a now-stale expected head.
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1]?.[4]).toBe(save.mock.calls[0]?.[4]);
  expect(save.mock.calls[1]?.[4]?.id).toBe("tombstone");
  expect(publishText.mock.calls[0]?.slice(0, 4)).toEqual([
    "crew",
    null,
    "crew-text",
    undefined,
  ]);
  expect(syncTeamInstructions).toHaveBeenCalledExactlyOnceWith(community, {
    crew: "",
  });
});
