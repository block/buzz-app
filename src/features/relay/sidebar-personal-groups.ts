import type { ChannelKit } from "../channel-templates/capability";
import { personalGroups } from "../channel-templates/setup";
import type { Groups } from "../channel-templates/model";
import type {
  SidebarAssignmentMutator,
  SidebarSectionRemovalMutator,
  SidebarSectionRemovalWriter,
  SidebarGroups,
  SidebarPreferences,
} from "./sidebar-preferences";

export function projectPersonalGroups(groups: Groups): SidebarGroups {
  return {
    sections: groups.groups.map(({ id, name }, order) => ({ id, name, order })),
    assignments: groups.assignments,
  };
}

/** Preserve the explicit new-Buzz opt-in; never migrate or merge either store. */
export async function readActiveSidebarGroups(
  kit: ChannelKit,
  legacy: SidebarPreferences,
  signal: AbortSignal,
): Promise<SidebarPreferences> {
  const state = kit.snapshot();
  if (state.status === "unavailable") return legacy;
  if (state.status !== "ready") await kit.refresh();
  signal.throwIfAborted();
  const loaded = kit.snapshot();
  if (loaded.status !== "ready")
    throw new Error(loaded.error ?? "Personal groups are unavailable");
  const entry = personalGroups(loaded.entries);
  return entry?.record.value.type === "groups"
    ? {
        ...legacy,
        ...projectPersonalGroups(entry.record.value),
        groupSource: "personal",
      }
    : legacy;
}

export function activeSidebarSectionRemoval(
  kit: ChannelKit,
  legacy: SidebarSectionRemovalWriter,
): SidebarSectionRemovalMutator {
  return async (sectionId, signal, source) => {
    signal.throwIfAborted();
    if (kit.snapshot().status === "unavailable") {
      if (source === "personal")
        throw new Error("Personal groups are unavailable");
      return legacy(sectionId, signal);
    }
    await kit.refresh();
    signal.throwIfAborted();
    const state = kit.snapshot();
    if (state.status !== "ready")
      throw new Error(state.error ?? "Personal groups could not be refreshed");
    const entry = personalGroups(state.entries);
    const current =
      entry?.record.value.type === "groups" ? entry.record.value : undefined;
    if (!!current !== (source === "personal"))
      throw new Error(
        "The active group source changed; refresh your sidebar before removing this section",
      );
    if (source === "legacy") return legacy(sectionId, signal);
    if (!current || !entry) throw new Error("Personal group no longer exists");
    const group = current.groups.find(({ id }) => id === sectionId);
    if (!group) throw new Error("Personal group no longer exists");
    const next: Groups = {
      ...current,
      groups: current.groups.filter(({ id }) => id !== sectionId),
      assignments: Object.fromEntries(
        Object.entries(current.assignments).filter(
          ([, id]) => id !== sectionId,
        ),
      ),
    };
    try {
      await kit.save(next, entry.eventId, false, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Please wait a second before saving this recipe again")
        throw new Error(
          "This section was just saved. Wait a second, then choose Remove section again.",
          { cause: error },
        );
      if (
        message ===
        "A save for this recipe is unresolved. Inspect Outbox and refresh before replacing it."
      )
        throw new Error(
          "A section removal or other personal-group save is unresolved. Open Channel settings → Diagnostics → Outbox to inspect or retry the existing operation, then reload the app to check the result before removing this section again.",
          { cause: error },
        );
      throw new Error(
        `Section removal could not be confirmed: ${message} Open Channel settings → Diagnostics → Outbox to inspect any pending operation before retrying.`,
        { cause: error },
      );
    }
    signal.throwIfAborted();
    const confirmed = personalGroups(kit.snapshot().entries)?.record.value;
    if (
      confirmed?.type !== "groups" ||
      confirmed.groups.some(({ id }) => id === sectionId) ||
      Object.values(confirmed.assignments).includes(sectionId)
    )
      throw new Error("Personal section removal could not be confirmed");
    return projectPersonalGroups(confirmed);
  };
}

/** Existing recipe delivery remains the sole writer for active personal groups. */
export function activeSidebarAssignment(
  kit: ChannelKit,
  legacy: SidebarAssignmentMutator,
): SidebarAssignmentMutator {
  return async (intent, signal, source) => {
    signal.throwIfAborted();
    if (kit.snapshot().status === "unavailable") {
      if (source) throw new Error("Personal groups are unavailable");
      return legacy(intent, signal);
    }
    await kit.refresh();
    signal.throwIfAborted();
    const state = kit.snapshot();
    if (state.status !== "ready")
      throw new Error(state.error ?? "Personal groups could not be refreshed");
    const entry = personalGroups(state.entries);
    const current =
      entry?.record.value.type === "groups" ? entry.record.value : undefined;
    if (!!current !== (source === "personal"))
      throw new Error(
        "The active group source changed; refresh your sidebar before moving this channel",
      );
    if (!current || !entry) return legacy(intent, signal);
    const target = intent.createSection?.id ?? intent.sectionId;
    let groups = current.groups;
    if (intent.createSection) {
      const name = intent.createSection.name.trim();
      const existing = groups.find(({ id }) => id === target);
      if (existing && existing.name !== name)
        throw new Error("The new section changed; refresh before retrying");
      if (!existing)
        groups = [
          ...groups,
          { id: intent.createSection.id, name, defaultTemplateId: "" },
        ];
    }
    if (target && !groups.some(({ id }) => id === target))
      throw new Error("The destination group is unavailable");
    const assignments = { ...current.assignments };
    if (target) assignments[intent.channelId] = target;
    else delete assignments[intent.channelId];
    if (
      groups === current.groups &&
      current.assignments[intent.channelId] === target
    )
      return projectPersonalGroups(current);
    const next = { ...current, groups, assignments };
    await kit.save(next, entry.eventId, false, signal);
    signal.throwIfAborted();
    const confirmed = personalGroups(kit.snapshot().entries)?.record.value;
    if (
      confirmed?.type !== "groups" ||
      confirmed.assignments[intent.channelId] !== target
    )
      throw new Error("Personal group placement could not be confirmed");
    return projectPersonalGroups(confirmed);
  };
}
