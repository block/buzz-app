import { expect, it } from "vitest";
import { KIT_TAG, ME_KIT_TAG, type Groups } from "../channel-templates/model";
import { TEAM_MANIFEST_TAG } from "../channel-templates/team-payload";
import {
  editSidebarAssignment,
  editSidebarSectionRemoval,
  editSidebarSectionRename,
} from "./sidebar-edits";
import { createRelaySession } from "./session";
import { importWorkspaceFallback } from "./sidebar-registers";
import {
  workspaceBaseRecord,
  expandWorkspaceRecord,
  workspacePayloadForSigning,
  workspaceRecordForWrite,
  type SidebarGroups,
} from "./sidebar-preferences";
import { flush, keypair, roster, scriptedTransport } from "./testing";
import { mergeLegacyWorkspaces } from "./workspace-migration";

const channel = "11111111-1111-4111-8111-111111111111";

it("retries a catalog read cancelled by initial roster authority", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    channelKit: { decode: async () => [], prepare: async () => "" },
  });
  try {
    const catalog = owner.session.channelKit.refresh();
    await flush();
    const interrupted = wire.next();
    expect(interrupted.filters[0]?.["#t"]).toEqual([
      KIT_TAG,
      TEAM_MANIFEST_TAG,
      ME_KIT_TAG,
    ]);
    owner.session.channels.ensureList();
    await flush();
    wire.next().respond([roster(relay, channel, [viewer.pubkey])]);
    await flush();
    expect(interrupted.signal?.aborted).toBe(true);
    const retry = wire.pending.find((entry) => entry.filters[0]?.["#t"]);
    expect(retry?.filters).toEqual(interrupted.filters);
    for (const entry of wire.pending.splice(0)) entry.respond([]);
    await catalog;
    expect(owner.session.channelKit.snapshot().status).toBe("ready");
  } finally {
    owner.dispose();
  }
});

it.each(["clearCache", "dispose"] as const)(
  "does not retry a catalog read cancelled by %s",
  async (action) => {
    const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      channelKit: { decode: async () => [], prepare: async () => "" },
    });
    try {
      const catalog = owner.session.channelKit.refresh();
      await flush();
      const interrupted = wire.next();
      owner[action]();
      await catalog;
      await flush();
      expect(interrupted.signal?.aborted).toBe(true);
      expect(wire.pending).toHaveLength(0);
    } finally {
      owner.dispose();
    }
  },
);

it("preserves both sets of filings, template coordinates and ordering when legacy IDs collide", () => {
  const solo: Groups = {
    type: "groups",
    id: "me",
    groups: [{ id: "work", name: "Notes", defaultTemplateId: "old-template" }],
    assignments: { chat: "work" },
  };
  const team: SidebarGroups = {
    sections: [
      { id: "work", name: "Release", order: 0, icon: "📚" },
      { id: "second", name: "Later", order: 1 },
    ],
    assignments: { dm: "work", forum: "second" },
  };
  expect(mergeLegacyWorkspaces(team, solo)).toEqual({
    sections: [
      { id: "work", name: "Notes", order: 0 },
      { id: "legacy-team:work", name: "Release", order: 1, icon: "📚" },
      { id: "second", name: "Later", order: 2 },
    ],
    assignments: { chat: "work", dm: "legacy-team:work", forum: "second" },
    legacyTemplates: { work: "old-template" },
  });
});

function legacyWithFilings(count: number, idLength: number): SidebarGroups {
  const sections = Array.from({ length: 20 }, (_, order) => ({
    id: `00000000-0000-0000-0000-${String(order).padStart(12, "0")}`,
    name: `Workspace ${order}`,
    order,
  }));
  return {
    sections,
    assignments: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        String(index).padStart(idLength, "x"),
        sections[index % sections.length]?.id,
      ]),
    ),
  } as SidebarGroups;
}

it("renames, moves, unfiles and deletes a legacy import near the byte limit", () => {
  const legacy = legacyWithFilings(700, 141);
  const source = workspaceBaseRecord(legacy);
  const target = legacy.sections[1]?.id ?? "";
  const original = legacy.sections[0]?.id ?? "";
  const [first, second] = Object.keys(legacy.assignments);
  if (!first || !second) throw new Error("Incomplete fixture");
  const edit = (next: Record<string, unknown>) =>
    workspaceRecordForWrite(next, legacy);

  const renamed = edit(editSidebarSectionRename(source, 0, original, "Notes"));
  expect(renamed.sections[0]?.name).toBe("Notes");
  expect(JSON.stringify(renamed).length).toBeGreaterThan(128_000);
  const moved = edit(
    editSidebarAssignment(renamed, 0, { channelId: first, sectionId: target }),
  );
  expect(moved.assignments[first]).toBe(target);
  const unfiled = edit(editSidebarAssignment(moved, 0, { channelId: second }));
  expect(unfiled.assignments).not.toHaveProperty(second);
  const deleted = edit(editSidebarSectionRemoval(unfiled, 0, original));
  expect(deleted.sections).toHaveLength(19);
  expect(deleted.removedSections).toEqual([original]);
  expect(deleted.unfiled).toContain(second);
  expect(
    importWorkspaceFallback(JSON.parse(JSON.stringify(deleted)), legacy),
  ).toEqual(deleted);
});

it("leaves an oversized legacy projection readable and never truncates it to save", () => {
  const legacy = legacyWithFilings(700, 190);
  const source = workspaceBaseRecord(legacy);
  expect(Object.keys(source.assignments)).toHaveLength(700);
  expect(() => workspacePayloadForSigning(source, legacy)).toThrow(
    "storage limit",
  );
  const reduced = editSidebarSectionRemoval(
    source,
    0,
    legacy.sections[0]?.id ?? "",
  );
  expect(workspacePayloadForSigning(reduced, legacy).sections).toHaveLength(19);
});

it("fits two full legacy rosters through rename, move, unfile and removal", () => {
  const sections = Array.from({ length: 200 }, (_, order) => ({
    id: `00000000-0000-4000-8000-${String(order).padStart(12, "0")}`,
    name: `Workspace ${order}`,
    order,
  }));
  const assignments = Object.fromEntries(
    Array.from({ length: 2000 }, (_, index) => [
      index.toString(16).padStart(64, "0"),
      sections[index % sections.length]?.id ?? "",
    ]),
  );
  const legacy = { sections, assignments };
  const source = workspaceBaseRecord(legacy);
  const [first, second] = Object.keys(assignments);
  const [original, destination] = sections;
  if (!first || !second || !original || !destination)
    throw new Error("Incomplete fixture");
  const readback = (value: Record<string, unknown>) => {
    const wire = JSON.stringify(workspacePayloadForSigning(value, legacy));
    expect(wire.length).toBeLessThan(128 * 1024);
    expect(JSON.parse(wire)).toHaveProperty("filings");
    return expandWorkspaceRecord(JSON.parse(wire));
  };
  const renamed = readback(
    editSidebarSectionRename(source, 0, original.id, "Renamed"),
  );
  expect(renamed).toMatchObject({ assignments });
  const moved = readback(
    editSidebarAssignment(renamed, 0, {
      channelId: first,
      sectionId: destination.id,
    }),
  );
  expect(moved.assignments).toHaveProperty(first, destination.id);
  const unfiled = readback(
    editSidebarAssignment(moved, 0, { channelId: second }),
  );
  expect(unfiled.assignments).not.toHaveProperty(second);
  const removed = readback(editSidebarSectionRemoval(unfiled, 0, original.id));
  expect(removed.removedSections).toEqual([original.id]);
  expect(removed.unfiled).toEqual([second]);
  expect(Object.keys(removed.assignments as object)).toHaveLength(1990);
});
