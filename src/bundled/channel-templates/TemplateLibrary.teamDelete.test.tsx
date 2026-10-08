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

it("deleting one of two teams with identical text releases only the deleted team, and a retry only resends", async () => {
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
  const kit = {
    available: true,
    snapshot: () => state,
    subscribe: () => () => {},
    ensure: vi.fn(),
    refresh: vi.fn(),
    save,
    loadTeam,
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
      control={{ syncTeamInstructions, previewTeam } as unknown as AgentControl}
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
  await user.click(screen.getByRole("button", { name: "Actions for Crew" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete team…" }),
  );
  const confirmation = screen.getByRole("dialog", { name: "Delete “Crew”?" });
  const remove = within(confirmation).getByRole("button", { name: "Delete" });
  await user.click(remove);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "controller offline",
  );
  await user.click(remove);
  await waitFor(() => expect(confirmation).not.toBeInTheDocument());
  expect(save).toHaveBeenCalledExactlyOnceWith(crew, "crew-head", true);
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
