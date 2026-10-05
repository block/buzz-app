import type {
  SidebarAssignmentIntent,
  SidebarGroups,
  SidebarSortMode,
} from "./sidebar-preferences.ts";
import {
  editSidebarRecord,
  nextSidebarSectionOrder,
} from "./sidebar-registers.ts";

// Pure edits of validated, projected heads. Hosts retain validation, signing,
// publication, readback and serialization; these functions never perform I/O.
export function editSidebarAssignment(
  current: Record<string, unknown>,
  createdAt: number,
  intent: SidebarAssignmentIntent,
  now = Date.now(),
): Record<string, unknown> {
  const { channelId, sectionId, createSection } = intent;
  const section = createSection?.id ?? sectionId;
  const existing = current.sections as SidebarGroups["sections"];
  const sections = [...existing];
  if (createSection) {
    const name = createSection.name.trim();
    const found = sections.find((entry) => entry.id === section);
    // Retrying an unknown publication retains the ID, never duplicates or renames.
    if (found && found.name !== name)
      throw new Error("The new section changed; reload and try again");
    if (!found)
      sections.push({
        id: createSection.id,
        name,
        order: nextSidebarSectionOrder(current),
      });
  }
  if (section !== undefined && !sections.some((entry) => entry.id === section))
    throw new Error("Sidebar group no longer exists");
  const writes: [string[], unknown][] = [[["a", channelId], section ?? null]];
  if (createSection && !existing.some(({ id }) => id === section)) {
    const added = sections.find(({ id }) => id === section);
    if (!added) throw new Error("Sidebar group no longer exists");
    writes.push(
      [["s", added.id, "name"], added.name],
      [["s", added.id, "icon"], null],
      [["s", added.id, "order"], added.order],
      [["s", added.id, "live"], true],
    );
  }
  return editSidebarRecord("channel-sections", current, createdAt, writes, now);
}

export function editSidebarSort(
  current: Record<string, unknown>,
  createdAt: number,
  group: string,
  mode: SidebarSortMode,
  now = Date.now(),
): Record<string, unknown> {
  return editSidebarRecord(
    "channel-sort",
    current,
    createdAt,
    [[["g", group], mode === "alpha" ? null : mode]],
    now,
  );
}

export function editSidebarToggle(
  current: Record<string, unknown>,
  channelId: string,
  field: "starred" | "muted",
  enabled: boolean,
  now = Date.now(),
): Record<string, unknown> {
  const channels = current.channels as Record<string, Record<string, unknown>>;
  const previous = Object.hasOwn(channels, channelId)
    ? channels[channelId]
    : undefined;
  // Absent unstars are satisfied; unmute must persist its explicit tombstone.
  if (
    previous?.[field] === enabled ||
    (!previous && !enabled && field === "starred")
  )
    return current;
  return {
    ...current,
    channels: {
      ...channels,
      [channelId]: {
        ...previous,
        [field]: enabled,
        updatedAt: Math.max(now, Number(previous?.updatedAt ?? 0) + 1),
      },
    },
  };
}
