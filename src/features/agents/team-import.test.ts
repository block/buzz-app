import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentControl } from "./control";
import type { ChannelKit } from "../channel-templates/capability";
import { importTeamMembers, type TeamSnapshot } from "./team-bundles";
import { importTeamSnapshot } from "./team-import";
vi.mock("./team-bundles", async (original) => ({
  ...(await original<typeof import("./team-bundles")>()),
  importTeamMembers: vi.fn(),
}));
const snapshot: TeamSnapshot = {
  format: "buzz-team-snapshot",
  version: 1,
  team: { name: "Fixture", description: "Purpose", instructions: "TEAM" },
  members: [
    {
      format: "buzz-agent-snapshot",
      version: 1,
      definition: { name: "One", systemPrompt: "INDIVIDUAL" },
      profile: { displayName: "One" },
      memory: {
        level: "core",
        entries: [{ slug: "core", body: "SAFE_MEMORY" }],
      },
    },
  ],
};
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.mocked(importTeamMembers).mockResolvedValue([
    { id: "copy", pubkey: "a".repeat(64) },
  ] as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function fixture() {
  const writeSnapshotMemory = vi.fn(async () => ({
    written: 1,
    total: 1,
    errors: [] as string[],
  }));
  const control = {
    previewTeam: vi.fn(async () => structuredClone(snapshot)),
    writeSnapshotMemory,
  } as unknown as AgentControl;
  const savePortable = vi.fn();
  const kit = {
    refresh: vi.fn(),
    snapshot: () => ({ entries: [] }),
    savePortable,
    readTextHead: vi.fn(async () => undefined),
    prepareText: vi.fn(async () => "text-manifest"),
    publishText: vi.fn(async () => "text-head"),
  } as unknown as ChannelKit;
  return { control, kit, writeSnapshotMemory, savePortable };
}
it("imports memory-bearing definitions without restoring memory unless explicitly requested", async () => {
  const { control, kit, writeSnapshotMemory, savePortable } = fixture();
  const result = await importTeamSnapshot(control, kit, snapshot, {
    destination: "https://relay.example",
    owner: "b".repeat(64),
    keepAllowlist: false,
  });
  expect(importTeamMembers).toHaveBeenCalledWith(
    control,
    snapshot,
    expect.any(Array),
    "https://relay.example",
    "b".repeat(64),
    false,
    result.id,
  );
  expect(writeSnapshotMemory).not.toHaveBeenCalled();
  expect(result.memories).toEqual([]);
  expect(savePortable.mock.calls[0]?.[1].team).toEqual(snapshot.team);
  expect(result.agents[0]?.pubkey).toBe("a".repeat(64));
});
it("retains the same creation requests on memory failure and reports per-member retry outcomes", async () => {
  const { control, kit, writeSnapshotMemory } = fixture();
  writeSnapshotMemory.mockResolvedValueOnce({
    written: 0,
    total: 1,
    errors: ["not confirmed"],
  });
  const options = {
    destination: "https://relay.example",
    owner: "b".repeat(64),
    keepAllowlist: false,
    restoreMemory: true,
  };
  const first = await importTeamSnapshot(control, kit, snapshot, options);
  const second = await importTeamSnapshot(control, kit, snapshot, options);
  expect(first.id).toBe(second.id);
  expect(vi.mocked(importTeamMembers).mock.calls[0]?.[2]).toEqual(
    vi.mocked(importTeamMembers).mock.calls[1]?.[2],
  );
  expect(first.memories).toEqual([
    { pubkey: "a".repeat(64), written: 0, total: 1, errors: ["not confirmed"] },
  ]);
  expect(second.memories[0]?.written).toBe(1);
  expect(writeSnapshotMemory).toHaveBeenCalledWith(
    "copy",
    snapshot.members[0]?.memory.entries,
  );
});
const textOptions = {
  destination: "https://relay.example",
  owner: "b".repeat(64),
  keepAllowlist: false,
};
it("writes the imported text as an explicit text head, and leaves an existing one alone", async () => {
  const { control, kit } = fixture();
  const result = await importTeamSnapshot(control, kit, snapshot, textOptions);
  expect(vi.mocked(kit.prepareText).mock.calls[0]?.slice(0, 2)).toEqual([
    result.id,
    snapshot.team.instructions ?? "",
  ]);
  expect(vi.mocked(kit.publishText).mock.calls[0]?.slice(0, 3)).toEqual([
    result.id,
    "text-manifest",
    undefined,
  ]);
  vi.mocked(kit.readTextHead).mockResolvedValueOnce({
    head: "f".repeat(64),
    deleted: false,
  });
  await importTeamSnapshot(control, kit, snapshot, textOptions);
  expect(kit.publishText).toHaveBeenCalledOnce();
});
const enqueuedHead = "e".repeat(64);
/** First attempt enqueues the text head, then loses its confirmation. */
function uncertainText(kit: ChannelKit) {
  vi.mocked(kit.publishText).mockImplementationOnce(
    async (_id, _manifest, _expected, _team, resume) => {
      resume?.enqueued(enqueuedHead);
      throw new Error("Save is awaiting exact relay confirmation");
    },
  );
}
it.each([
  ["not visible yet", undefined],
  ["visible", { head: enqueuedHead, deleted: false }],
])(
  "a retry confirms an enqueued imported text head that is %s, with the same revision",
  async (_, visible) => {
    const { control, kit } = fixture();
    uncertainText(kit);
    await expect(
      importTeamSnapshot(control, kit, snapshot, textOptions),
    ).rejects.toThrow("awaiting exact relay confirmation");
    vi.mocked(kit.readTextHead).mockResolvedValueOnce(visible);
    await importTeamSnapshot(control, kit, snapshot, textOptions);
    const [first, retry] = vi.mocked(kit.publishText).mock.calls;
    expect(retry?.[4]?.id).toBe(enqueuedHead);
    const revisions = vi
      .mocked(kit.prepareText)
      .mock.calls.map((call) => call[2]);
    expect(revisions[1]).toBe(revisions[0]);
    expect(first?.[0]).toBe(retry?.[0]);
  },
);
it("a retry never overwrites a text edit made after the import enqueued its head", async () => {
  const { control, kit } = fixture();
  uncertainText(kit);
  await expect(
    importTeamSnapshot(control, kit, snapshot, textOptions),
  ).rejects.toThrow();
  // The user edited the team's text since; that head is not the import's.
  vi.mocked(kit.readTextHead).mockResolvedValueOnce({
    head: "d".repeat(64),
    deleted: false,
  });
  await importTeamSnapshot(control, kit, snapshot, textOptions);
  expect(kit.publishText).toHaveBeenCalledOnce();
  expect(kit.prepareText).toHaveBeenCalledOnce();
});
