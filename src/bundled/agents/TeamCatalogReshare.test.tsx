// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createCommunityCatalog } from "../../features/agents/catalog";
import {
  catalogTeamSnapshot,
  parsePublication,
  TEAM_CATALOG_KIND,
  type TeamPublication,
} from "../../features/agents/catalog-protocol";
import {
  catalogRelay,
  memoryStorage,
} from "../../features/agents/catalog-testing";
import type { AgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import {
  importTeamMembers,
  type TeamSnapshot,
} from "../../features/agents/team-bundles";
import { importTeamSnapshot } from "../../features/agents/team-import";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type { Team } from "../../features/channel-templates/model";
import { relayOrigin } from "../../features/communities/destination";
import { createOutbox } from "../../features/relay/outbox";
import { relayPartition } from "../../features/relay/partition";
import type { RelaySession } from "../../features/relay/session";
import { keypair, signed } from "../../features/relay/testing";
import { TeamShareDialog } from "./CommunityCatalog";

// Member creation is the importer's own native boundary; everything that
// carries team metadata — preview, receipt, portable save — runs for real.
vi.mock("../../features/agents/team-bundles", async (original) => ({
  ...(await original<typeof import("../../features/agents/team-bundles")>()),
  importTeamMembers: vi.fn(),
}));

const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.clearAllMocks();
});

it("re-sharing an adopted team keeps its description and instructions", async () => {
  const publisher = keypair(),
    adopter = keypair();
  const server = catalogRelay();
  server.put(
    signed(publisher, {
      kind: 30178,
      tags: [
        ["d", "crew"],
        ["shared", "true"],
      ],
      content: JSON.stringify({
        v: 1,
        name: "Crew",
        description: "Ships releases.",
        instructions: "Coordinate in threads.",
        members: [
          { member_key: "k1", display_name: "Mate", system_prompt: "Help." },
        ],
      }),
      created_at: 1,
    }),
  );
  const [head] = await server
    .reader(adopter)
    .read([{ kinds: [30178], limit: 10 }]);
  if (!head) throw new Error("team not published");
  const listed = parsePublication(head) as TeamPublication;

  const copy = {
    ...controlFixture().agent,
    id: "copy-1",
    pubkey: "cd".repeat(32),
    name: "Mate",
    systemPrompt: "Help.",
  };
  vi.mocked(importTeamMembers).mockResolvedValue([
    { id: copy.id, pubkey: copy.pubkey, name: copy.name },
  ] as never);
  const control = {
    snapshot: () => ({ data: { agents: [copy] } }),
    previewTeam: async (content: string) => JSON.parse(content) as TeamSnapshot,
  } as unknown as AgentControl;
  let saved: { team: Team; snapshot: TeamSnapshot } | undefined;
  const kit = {
    refresh: async () => {},
    snapshot: () => ({ entries: [] }),
    savePortable: async (team: Team, snapshot: TeamSnapshot) => {
      saved = { team, snapshot };
    },
    loadTeam: async (team: Team) => {
      expect(team.id).toBe(saved?.team.id);
      return saved?.snapshot;
    },
  } as unknown as ChannelKit;
  const imported = await importTeamSnapshot(
    control,
    kit,
    catalogTeamSnapshot(listed),
    {
      destination: copy.relayUrl,
      owner: adopter.pubkey,
      keepAllowlist: false,
      restoreMemory: false,
    },
  );

  const writes = createOutbox(
    adopter.pubkey,
    server.writer(adopter),
    memoryStorage(),
    { timeoutMs: 1_000 },
  );
  const catalog = createCommunityCatalog({
    reader: server.reader(adopter),
    viewer: adopter.pubkey,
    outbox: writes.outbox,
    local: writes.local,
  });
  owners.push(catalog, { dispose: () => writes.dispose() });
  const session = {
    communityCatalog: catalog.queries,
    scope: relayPartition(relayOrigin(copy.relayUrl), adopter.pubkey),
  } as unknown as RelaySession;
  if (!saved) throw new Error("import saved no portable team");
  render(
    <TeamShareDialog
      session={session}
      control={control}
      kit={kit}
      team={{
        ...saved.team,
        portable: { revision: imported.id } as NonNullable<Team["portable"]>,
      }}
      onClose={() => {}}
    />,
  );
  const share = await screen.findByRole("switch", {
    name: /Share to catalog/,
  });
  await waitFor(() => expect(share).not.toHaveAttribute("data-disabled"));
  fireEvent.click(share);
  let reshared: TeamPublication | undefined;
  await waitFor(async () => {
    const events = await server
      .reader(publisher)
      .read([{ kinds: [30178], limit: 10 }]);
    const own = events.find((event) => event.pubkey === adopter.pubkey);
    if (!own) throw new Error("re-share not published yet");
    reshared = parsePublication(own) as TeamPublication;
  });
  expect(reshared).toMatchObject({
    name: "Crew",
    description: "Ships releases.",
    instructions: "Coordinate in threads.",
    members: [{ displayName: "Mate", systemPrompt: "Help." }],
  });
});

/** A portable team whose saved definition loads only when the test says so. */
function pendingShare() {
  const owner = keypair();
  const server = catalogRelay();
  const member = {
    ...controlFixture().agent,
    id: "member-1",
    pubkey: "ef".repeat(32),
    name: "Mate",
    systemPrompt: "Help.",
  };
  let settle!: { resolve(value: unknown): void; reject(error: Error): void };
  const loadTeam = vi.fn(
    () =>
      new Promise((resolve, reject) => {
        settle = { resolve, reject };
      }),
  );
  const control = {
    snapshot: () => ({ data: { agents: [member] } }),
    previewTeam: async (content: string) => JSON.parse(content) as TeamSnapshot,
  } as unknown as AgentControl;
  const writes = createOutbox(
    owner.pubkey,
    server.writer(owner),
    memoryStorage(),
    { timeoutMs: 1_000 },
  );
  const catalog = createCommunityCatalog({
    reader: server.reader(owner),
    viewer: owner.pubkey,
    outbox: writes.outbox,
    local: writes.local,
  });
  owners.push(catalog, { dispose: () => writes.dispose() });
  const session = {
    communityCatalog: catalog.queries,
    scope: relayPartition(relayOrigin(member.relayUrl), owner.pubkey),
  } as unknown as RelaySession;
  const onClose = vi.fn();
  const dialog = (
    <TeamShareDialog
      session={session}
      control={control}
      kit={{ loadTeam } as unknown as ChannelKit}
      team={{
        type: "team",
        id: "crew",
        name: "Crew",
        agents: [member.pubkey],
        portable: { revision: "r1" } as NonNullable<Team["portable"]>,
      }}
      onClose={onClose}
    />
  );
  const published = async () =>
    (await server.reader(owner).read([{ kinds: [30178], limit: 10 }])).filter(
      (event) => event.pubkey === owner.pubkey,
    );
  return {
    dialog,
    onClose,
    loadTeam,
    published,
    settle: () => settle,
    queries: catalog.queries,
  };
}

async function startShare(loadTeam: ReturnType<typeof vi.fn>) {
  const share = await screen.findByRole("switch", { name: /Share to catalog/ });
  await waitFor(() => expect(share).not.toHaveAttribute("data-disabled"));
  fireEvent.click(share);
  await waitFor(() => expect(loadTeam).toHaveBeenCalledTimes(1));
}

it("keeps the share dialog open until a pending portable read publishes", async () => {
  const user = userEvent.setup();
  const test = pendingShare();
  render(test.dialog);
  await startShare(test.loadTeam);

  const close = screen.getByRole("button", { name: "Close" });
  expect(close).toBeDisabled();
  await user.keyboard("{Escape}");
  await user.click(close);
  expect(test.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Share Crew" })).toBeVisible();

  test.settle().resolve({ team: { name: "Crew", description: "Late." } });
  await waitFor(async () => {
    const [own] = await test.published();
    if (!own) throw new Error("share not published yet");
    expect(parsePublication(own)).toMatchObject({ description: "Late." });
  });
  await waitFor(() => expect(close).toBeEnabled());
  await user.click(close);
  expect(test.onClose).toHaveBeenCalledTimes(1);
});

it("shows a failed portable read and lets the dialog close without publishing", async () => {
  const user = userEvent.setup();
  const test = pendingShare();
  render(test.dialog);
  await startShare(test.loadTeam);

  test.settle().reject(new Error("Saved team is unreadable"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Saved team is unreadable",
  );
  const close = screen.getByRole("button", { name: "Close" });
  await waitFor(() => expect(close).toBeEnabled());
  await user.keyboard("{Escape}");
  expect(test.onClose).toHaveBeenCalledTimes(1);
  expect(test.queries.state(TEAM_CATALOG_KIND, "crew").change).toBeUndefined();
  expect(await test.published()).toEqual([]);
});

it("does not publish a projection that settles after the dialog is gone", async () => {
  const test = pendingShare();
  const view = render(test.dialog);
  await startShare(test.loadTeam);

  view.unmount();
  test.settle().resolve({ team: { name: "Crew" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(test.queries.state(TEAM_CATALOG_KIND, "crew").change).toBeUndefined();
  expect(await test.published()).toEqual([]);
});
