import { expect, it, vi } from "vitest";
import type { ChannelSummary } from "./contracts";
import type { RelaySession } from "./session";
import { sidebarSections } from "./sidebar-agent-sections";
import type {
  SidebarAssignmentIntent,
  SidebarGroups,
  SidebarPreferences,
} from "./sidebar-preferences";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";

const channels: ChannelSummary[] = [
  { id: "c-dev", name: "dev", channelType: "stream" },
  { id: "c-help", name: "help", channelType: "stream" },
  { id: "c-old", name: "old", channelType: "stream", archived: true },
  { id: "c-dm", name: "pat", channelType: "dm" },
  { id: "c-twin-1", name: "twin", channelType: "stream" },
  { id: "c-twin-2", name: "Twin", channelType: "stream" },
] as ChannelSummary[];

function setup(options: Readonly<{ failCreate?: "lost" | "saved" }> = {}) {
  let data: SidebarPreferences = {
    sections: [
      { id: "s-b", name: "Later", order: 1 },
      { id: "s-a", name: "First", order: 0 },
    ],
    assignments: { "c-dev": "s-a" },
    starred: ["c-help"],
    muted: [],
  };
  const groups = (): SidebarGroups => ({
    sections: data.sections,
    assignments: data.assignments,
  });
  const write = vi.fn(
    async (intent: SidebarAssignmentIntent): Promise<SidebarGroups> => {
      const { channelId, sectionId, createSection } = intent;
      if (createSection) {
        data = {
          ...data,
          sections: [
            ...data.sections,
            { ...createSection, order: data.sections.length },
          ],
        };
        if (options.failCreate) {
          if (options.failCreate === "lost")
            data = { ...data, sections: data.sections.slice(0, -1) };
          throw new Error("confirmation timed out");
        }
      }
      if (channelId) {
        const assignments = { ...data.assignments };
        if (sectionId) assignments[channelId] = sectionId;
        else delete assignments[channelId];
        data = {
          ...data,
          assignments,
          starred: sectionId
            ? data.starred.filter((id) => id !== channelId)
            : data.starred,
        };
      }
      return groups();
    },
  );
  const store = createSidebarPreferencesStore({
    read: async () => data,
    available: true,
    write,
    writeStar: async () => [],
    renameSection: async ({ sectionId, name }) => {
      data = {
        ...data,
        sections: data.sections.map((section) =>
          section.id === sectionId ? { ...section, name } : section,
        ),
      };
      return groups();
    },
  });
  const session = {
    sidebarPreferences: store.queries,
    channels: { list: () => ({ channels }) },
  } as unknown as RelaySession;
  return { sections: sidebarSections(session), write };
}

it("lists sections in sidebar order with channel names and starred channels", async () => {
  const { sections } = setup();
  expect(await sections.list()).toEqual({
    sections: [
      { id: "s-a", name: "First", channels: [{ id: "c-dev", name: "dev" }] },
      { id: "s-b", name: "Later", channels: [] },
    ],
    starred: [{ id: "c-help", name: "help" }],
  });
});

it("creates a trimmed section and assigns channels by id or name", async () => {
  const { sections } = setup();
  const created = await sections.create("  Projects ");
  expect(created.name).toBe("Projects");
  await sections.assign("#help", created.id);
  await sections.assign("c-dev", created.id);
  const listed = await sections.list();
  expect(listed.sections.at(-1)).toEqual({
    id: created.id,
    name: "Projects",
    channels: [
      { id: "c-dev", name: "dev" },
      { id: "c-help", name: "help" },
    ],
  });
  expect(listed.starred).toEqual([]);
  await sections.assign("dev", undefined);
  expect((await sections.list()).sections.at(-1)?.channels).toEqual([
    { id: "c-help", name: "help" },
  ]);
});

it("renames a section and refuses unknown sections and channels", async () => {
  const { sections, write } = setup();
  await sections.rename("s-b", "Next");
  expect((await sections.list()).sections[1]?.name).toBe("Next");
  await expect(sections.rename("nope", "X")).rejects.toThrow("No section nope");
  await expect(sections.assign("dev", "nope")).rejects.toThrow(
    "No section nope",
  );
  await expect(sections.assign("ghost", "s-a")).rejects.toThrow(
    "You aren't in channel ghost",
  );
  await expect(sections.assign("old", "s-a")).rejects.toThrow(
    "old can't go in a section",
  );
  await expect(sections.assign("c-dm", "s-a")).rejects.toThrow(
    "pat can't go in a section",
  );
  await expect(sections.assign("twin", "s-a")).rejects.toThrow(
    "More than one channel is named twin",
  );
  await expect(sections.create("   ")).rejects.toThrow("needs a name");
  await expect(sections.create("x".repeat(257))).rejects.toThrow("at most 256");
  expect(write).not.toHaveBeenCalled();
});

it("reports a created section whose confirmation failed but was saved", async () => {
  const saved = setup({ failCreate: "saved" });
  const created = await saved.sections.create("Ops");
  expect((await saved.sections.list()).sections.map(({ id }) => id)).toContain(
    created.id,
  );
  const lost = setup({ failCreate: "lost" });
  await expect(lost.sections.create("Ops")).rejects.toThrow(
    "confirmation timed out",
  );
});
