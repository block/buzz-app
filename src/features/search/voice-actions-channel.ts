// Built-in Milestone 1 channel & sidebar voice actions.
import type { AppVoiceAction } from "./voice-actions-app";
import type { VoiceEntity } from "./voice-actions";

function channelIsStarred(
  channelId: string,
  meta: Readonly<Record<string, unknown>> | undefined,
  ctx: Parameters<NonNullable<AppVoiceAction["available"]>>[0],
): boolean {
  const starred = ctx.session.sidebarPreferences.snapshot().data?.starred;
  if (starred) return starred.includes(channelId);
  return meta?.starred === true || meta?.sectionKey === "starred";
}

function channelPlacementWritable(
  ctx: Parameters<NonNullable<AppVoiceAction["available"]>>[0],
  channelType: unknown,
): boolean {
  const prefs = ctx.session.sidebarPreferences;
  return (
    prefs.writable &&
    prefs.starWritable &&
    !!prefs.snapshot().data &&
    channelType !== "forum"
  );
}

export const channelVoiceActions: readonly AppVoiceAction[] = [
  {
    id: "channel.star",
    owner: "channel",
    confirm: "none",
    available: (ctx, { bound }) => {
      if (!bound) return false;
      return (
        channelPlacementWritable(ctx, bound.meta?.channelType) &&
        !channelIsStarred(bound.id, bound.meta, ctx)
      );
    },
    describe: ({ bound }) =>
      `Star ${bound?.label ?? "this channel"} (pin to Starred / Favorites)`,
    summary: ({ owner }) => `Star ${owner?.label ?? "channel"}`,
    run: async ({ ctx, owner }, env) => {
      if (!owner) throw new Error("No channel selected.");
      await ctx.session.sidebarPreferences.ensure();
      if (!ctx.session.sidebarPreferences.starWritable) {
        throw new Error("Sidebar preferences are not ready yet.");
      }
      await ctx.session.sidebarPreferences.setStar(owner.id, true);
      env.notify(`Starred ${owner.label}`, "success");
    },
  },
  {
    id: "channel.unstar",
    owner: "channel",
    confirm: "none",
    available: (ctx, { bound }) => {
      if (!bound) return false;
      return (
        channelPlacementWritable(ctx, bound.meta?.channelType) &&
        channelIsStarred(bound.id, bound.meta, ctx)
      );
    },
    describe: ({ bound }) =>
      `Unstar ${bound?.label ?? "this channel"} (remove from Starred / Favorites)`,
    summary: ({ owner }) => `Unstar ${owner?.label ?? "channel"}`,
    run: async ({ ctx, owner }, env) => {
      if (!owner) throw new Error("No channel selected.");
      await ctx.session.sidebarPreferences.ensure();
      if (!ctx.session.sidebarPreferences.starWritable) {
        throw new Error("Sidebar preferences are not ready yet.");
      }
      await ctx.session.sidebarPreferences.setStar(owner.id, false);
      env.notify(`Removed ${owner.label} from Starred`, "success");
    },
  },
  {
    id: "channel.move_to_section",
    owner: "section",
    target: "channel",
    confirm: "none",
    available: (ctx, { hoveredRole, bound }) => {
      const prefs = ctx.session.sidebarPreferences;
      if (!prefs.writable || !prefs.snapshot().data) return false;
      if (hoveredRole === "target") {
        // Hovering a channel: move into a custom section (or back out of one).
        // Starred is handled exclusively by `channel.star`.
        if (!bound || bound.meta?.channelType === "forum") return false;
        const hasCustom = (prefs.snapshot().data?.sections.length ?? 0) > 0;
        const inCustom =
          typeof bound.meta?.sectionKey === "string" &&
          bound.meta.sectionKey.startsWith("group:");
        return hasCustom || inCustom;
      }
      if (hoveredRole === "owner") {
        if (!bound) return false;
        if (bound.id === "starred") return prefs.starWritable;
        return (
          bound.id.startsWith("group:") ||
          bound.id === "channels" ||
          bound.id === "dms"
        );
      }
      return false;
    },
    filterSlot: (slot, candidate: VoiceEntity, bound) => {
      if (slot === "section") {
        if (candidate.id === "starred") return false;
        const channelType = bound?.meta?.channelType;
        if (candidate.id === "dms" && channelType !== "dm") return false;
        if (candidate.id === "channels" && channelType === "dm") return false;
        if (
          typeof bound?.meta?.sectionKey === "string" &&
          candidate.id === bound.meta.sectionKey
        ) {
          return false;
        }
        return true;
      }
      if (slot === "channel") {
        return candidate.meta?.channelType !== "forum";
      }
      return true;
    },
    describe: ({ hoveredRole, bound }) =>
      hoveredRole === "owner"
        ? bound?.id === "starred"
          ? "Star a channel (add a channel to Starred / Favorites)"
          : // Said the way people ask while pointing at the section, so
            // "put X in here" reads as this move, not as going to X.
            `Put a channel in here, into ${bound?.label ?? "this section"} (move it to this section)`
        : `Move ${bound?.label ?? "this channel"} into a sidebar section`,
    summary: ({ owner, target }) =>
      `Move ${target?.label ?? "channel"} to ${owner?.label ?? "section"}`,
    run: async ({ ctx, owner, target }, env) => {
      if (!owner || !target) {
        throw new Error("Both a channel and a destination section are needed.");
      }
      await ctx.session.sidebarPreferences.ensure();
      if (!ctx.session.sidebarPreferences.writable) {
        throw new Error("Sidebar preferences are not ready yet.");
      }
      if (owner.id === "starred") {
        await ctx.session.sidebarPreferences.setStar(target.id, true);
        env.notify(`Starred ${target.label}`, "success");
        return;
      }
      if (owner.id === "channels" || owner.id === "dms") {
        await ctx.session.sidebarPreferences.assign(target.id, undefined);
        env.notify(`Moved ${target.label} to ${owner.label}`, "success");
        return;
      }
      const sectionId =
        typeof owner.meta?.sectionId === "string"
          ? owner.meta.sectionId
          : owner.id.startsWith("group:")
            ? owner.id.slice("group:".length)
            : owner.id;
      await ctx.session.sidebarPreferences.assign(target.id, sectionId);
      env.notify(`Moved ${target.label} to ${owner.label}`, "success");
    },
  },
];
