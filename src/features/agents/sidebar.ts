import type { RelaySession } from "../relay/session";
import type { SidebarGroups } from "../relay/sidebar-preferences";

/** Owner sidebar access for an agent's own run, never a plugin handle. */
export type AgentSidebar = Readonly<{
  list(signal: AbortSignal): Promise<SidebarGroups>;
  move(
    channel: string,
    section: string | undefined,
    signal: AbortSignal,
  ): Promise<void>;
}>;

/** Reuse the owner's session, including its queued, host-signed preference edits. */
export function agentSidebar(
  session: () => RelaySession | undefined,
  owner: string,
): AgentSidebar {
  const current = () => {
    const found = session();
    if (!found) throw new Error("Your community is not connected.");
    return found;
  };
  return {
    async list(signal) {
      signal.throwIfAborted();
      const bound = current();
      await bound.sidebarPreferences.refresh();
      signal.throwIfAborted();
      if (current() !== bound) throw new Error("Your community changed.");
      const state = bound.sidebarPreferences.snapshot();
      if (state.status !== "ready" || state.cached || !state.data)
        throw new Error(
          state.error ?? "Saved sidebar preferences are unavailable.",
        );
      const { sections, assignments } = state.data;
      return { sections, assignments };
    },
    async move(channelId, sectionId, signal) {
      signal.throwIfAborted();
      const bound = current();
      const preferences = bound.sidebarPreferences;
      if (!preferences.writable) await preferences.refresh();
      signal.throwIfAborted();
      if (current() !== bound) throw new Error("Your community changed.");
      const roster = bound.channels.list();
      const channel = roster.channels.find(({ id }) => id === channelId);
      if (
        roster.status !== "ready" ||
        !channel ||
        channel.cached ||
        channel.metadataPending ||
        (channel.hidden && channel.channelType !== "dm") ||
        !channel.members?.includes(owner) ||
        channel.archived ||
        channel.huddle ||
        channel.channelType === "forum" ||
        channel.channelType === "solo" ||
        channel.channelType === "system"
      )
        throw new Error("Choose an active channel you have joined.");
      if (
        sectionId !== undefined &&
        !preferences
          .snapshot()
          .data?.sections.some(({ id }) => id === sectionId)
      )
        throw new Error("No sidebar section with that ID. Use section_list.");
      await preferences.assign(channelId, sectionId, signal);
      signal.throwIfAborted();
      if (current() !== bound) throw new Error("Your community changed.");
    },
  };
}
