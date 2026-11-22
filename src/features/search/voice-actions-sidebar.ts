// Voice actions on sidebar channel rows, sidebar sections and the community:
// mute, read state, copy link, leave/archive, create/rename sections, filter,
// sort, collapse and mark all read. Each calls the operation its menu item
// calls; star, unstar and move live in voice-actions-channel.ts.
import { writeClipboardText } from "../../shared/clipboard";
import { lifecycleOffer } from "../relay/channel-lifecycle-protocol";
import type { ChannelLifecycleAction } from "../relay/channel-lifecycle-protocol";
import type { ChannelSummary } from "../relay/contracts";
import type { SidebarFilterMode } from "../relay/sidebar-preferences";
import type { SidebarSortMode } from "../relay/sidebar-sort";
import type { RelaySession } from "../relay/session";
import type { VoiceEntity } from "./voice-actions";
import type {
  AppVoiceAction,
  VoiceActionContext,
  VoiceActionEnv,
} from "./voice-actions-app";
import type { VoiceThing } from "./voice-context";

/** The sidebar's own mute and lifecycle owners, from `useChannelNavigation`,
 * so a spoken mute or leave behaves as the row menu's does. */
export type ChannelNavigationEnv = Readonly<{
  channelNavigation?:
    | Readonly<{
        mute: { change(channelId: string, name: string, muted: boolean): void };
        openLifecycle(
          channel: ChannelSummary,
          action: ChannelLifecycleAction,
        ): void;
      }>
    | undefined;
}>;
const channelNavigation = (env: VoiceActionEnv) =>
  (env as VoiceActionEnv & ChannelNavigationEnv).channelNavigation;

/** The channel a bound entity names, from the session's live list. */
export function channelOf(
  session: Pick<RelaySession, "channels">,
  entity: VoiceEntity | undefined,
): ChannelSummary | undefined {
  if (!entity) return undefined;
  const carried = entity.meta?.channel as ChannelSummary | undefined;
  return (
    session.channels.list().channels.find(({ id }) => id === entity.id) ??
    carried
  );
}

const placeable = (channel: ChannelSummary | undefined) =>
  !!channel &&
  !channel.cached &&
  !channel.archived &&
  channel.channelType !== "forum" &&
  channel.channelType !== "system";

// ---------------------------------------------------------------------------
// Channel rows
// ---------------------------------------------------------------------------

const isMuted = (ctx: VoiceActionContext, channelId: string) =>
  ctx.session.sidebarPreferences.snapshot().data?.muted.includes(channelId) ??
  false;

const muteWritable = (ctx: VoiceActionContext) =>
  ctx.session.sidebarPreferences.muteWritable &&
  !!ctx.session.sidebarPreferences.snapshot().data;

const changeMute = async (
  { ctx, owner }: Parameters<AppVoiceAction["run"]>[0],
  env: VoiceActionEnv,
  muted: boolean,
) => {
  if (!owner) throw new Error("No channel selected.");
  const name = (owner.meta?.name as string | undefined) ?? owner.label;
  // The sidebar's own optimistic mute keeps the row's pending state and error.
  const mute = channelNavigation(env)?.mute;
  if (mute) mute.change(owner.id, name, muted);
  else await ctx.session.sidebarPreferences.setMute(owner.id, muted);
  env.notify(`${muted ? "Muted" : "Unmuted"} ${owner.label}`, "success");
};

const frontierSync = (ctx: VoiceActionContext) =>
  ctx.session.unread?.sync?.().capability === "frontier-sync";

/** As the row menu decides between Mark as read and Mark as unread. */
export function channelHasUnread(
  ctx: Pick<VoiceActionContext, "session">,
  channelId: string,
) {
  const snapshot = ctx.session.unread.snapshot({ kind: "channel", channelId });
  return snapshot.manual !== "none" || (snapshot.observedCount ?? 0) > 0;
}

const lifecycle = (ctx: VoiceActionContext, bound: VoiceEntity | undefined) => {
  const channel = channelOf(ctx.session, bound);
  if (!channel || !ctx.session.channelLifecycle?.available) return undefined;
  // Owner-agent evidence is left false: the confirm dialog rechecks it all.
  const offer = lifecycleOffer(channel, ctx.session.viewer ?? "", false);
  return offer && { channel, offer };
};

const openLifecycle = (
  { ctx, owner }: Parameters<AppVoiceAction["run"]>[0],
  env: VoiceActionEnv,
  action: "leave" | "archive",
) => {
  const channel = channelOf(ctx.session, owner);
  const open = channelNavigation(env)?.openLifecycle;
  if (!channel || !open)
    throw new Error("Channel actions aren't available here.");
  // The existing dialog is the confirmation; it rechecks against the relay.
  open(channel, action);
};

export const channelRowVoiceActions: readonly AppVoiceAction[] = [
  {
    id: "channel.mute",
    owner: "channel",
    confirm: "none",
    available: (ctx, { bound }) =>
      !!bound &&
      muteWritable(ctx) &&
      !channelOf(ctx.session, bound)?.cached &&
      !isMuted(ctx, bound.id),
    describe: ({ bound }) =>
      `Mute ${bound?.label ?? "this channel"} (stop its notifications)`,
    summary: ({ owner }) => `Mute ${owner?.label ?? "channel"}`,
    run: (invocation, env) => changeMute(invocation, env, true),
  },
  {
    id: "channel.unmute",
    owner: "channel",
    confirm: "none",
    available: (ctx, { bound }) =>
      !!bound && muteWritable(ctx) && isMuted(ctx, bound.id),
    describe: ({ bound }) =>
      `Unmute ${bound?.label ?? "this channel"} (notify me again)`,
    summary: ({ owner }) => `Unmute ${owner?.label ?? "channel"}`,
    run: (invocation, env) => changeMute(invocation, env, false),
  },
  {
    id: "channel.mark_read",
    owner: "channel",
    confirm: "none",
    available: (ctx, { bound }) =>
      !!bound && frontierSync(ctx) && channelHasUnread(ctx, bound.id),
    describe: ({ bound }) => `Mark ${bound?.label ?? "this channel"} as read`,
    summary: ({ owner }) => `Mark ${owner?.label ?? "channel"} as read`,
    run: async ({ ctx, owner }, env) => {
      if (!owner) throw new Error("No channel selected.");
      await ctx.session.unread.markChannelRead(owner.id);
      env.notify(`Marked ${owner.label} as read`, "success");
    },
  },
  {
    id: "channel.mark_unread",
    owner: "channel",
    confirm: "none",
    available: (ctx, { bound }) =>
      !!bound && frontierSync(ctx) && !channelHasUnread(ctx, bound.id),
    describe: ({ bound }) => `Mark ${bound?.label ?? "this channel"} as unread`,
    summary: ({ owner }) => `Mark ${owner?.label ?? "channel"} as unread`,
    run: async ({ ctx, owner }, env) => {
      if (!owner) throw new Error("No channel selected.");
      await ctx.session.unread.markUnreadLocal({
        kind: "channel",
        channelId: owner.id,
      });
      env.notify(`Marked ${owner.label} as unread`, "success");
    },
  },
  {
    id: "channel.copy_link",
    owner: "channel",
    confirm: "none",
    available: (_ctx, { bound }) => !!bound,
    describe: ({ bound }) => `Copy a link to ${bound?.label ?? "this channel"}`,
    summary: ({ owner }) => `Copy link to ${owner?.label ?? "channel"}`,
    run: async ({ owner }, env) => {
      if (!owner) throw new Error("No channel selected.");
      // The link carries no community, as the row menu's Copy link.
      await writeClipboardText(
        `buzz://channel/${encodeURIComponent(owner.id)}`,
      ).then(
        () => env.notify("Link copied.", "success"),
        () => env.notify("Couldn’t copy the link.", "error"),
      );
    },
  },
  {
    id: "channel.leave",
    owner: "channel",
    confirm: "none",
    available: (ctx, { bound }) => !!lifecycle(ctx, bound)?.offer.canLeave,
    describe: ({ bound }) => `Leave ${bound?.label ?? "this channel"}`,
    summary: ({ owner }) => `Leave ${owner?.label ?? "channel"}`,
    run: (invocation, env) => openLifecycle(invocation, env, "leave"),
  },
  {
    id: "channel.archive",
    owner: "channel",
    confirm: "none",
    available: (ctx, { bound }) => !!lifecycle(ctx, bound)?.offer.canArchive,
    describe: ({ bound }) => `Archive ${bound?.label ?? "this channel"}`,
    summary: ({ owner }) => `Archive ${owner?.label ?? "channel"}`,
    run: (invocation, env) => openLifecycle(invocation, env, "archive"),
  },
  {
    id: "channel.move_to_new_section",
    owner: "channel",
    target: "text",
    // The name comes from the transcript: always shown before it applies.
    confirm: "confirm",
    available: (ctx, { bound }) => {
      const prefs = ctx.session.sidebarPreferences;
      return (
        !!bound &&
        prefs.writable &&
        prefs.sectionCreationWritable &&
        !!prefs.snapshot().data &&
        placeable(channelOf(ctx.session, bound))
      );
    },
    extractText: (spoken) => extractNewSectionName(spoken),
    describe: ({ bound }) =>
      `Create a new sidebar section and move ${bound?.label ?? "this channel"} into it`,
    summary: ({ owner, text }) =>
      `Move ${owner?.label ?? "channel"} to new section “${text ?? ""}”`,
    run: async ({ ctx, owner, text }, env) => {
      const name = text?.trim();
      if (!owner || !name) throw new Error("Say the new section's name.");
      await ctx.session.sidebarPreferences.createAndAssign(owner.id, {
        id: crypto.randomUUID(),
        name,
      });
      env.notify(`Moved ${owner.label} to ${name}`, "success");
    },
  },
];

// ---------------------------------------------------------------------------
// Sidebar sections
// ---------------------------------------------------------------------------

/** The preference key a section's filter and sort are saved under. */
export const sectionPreferenceKey = (sectionKey: string) =>
  sectionKey.startsWith("group:")
    ? `section:${sectionKey.slice("group:".length)}`
    : sectionKey;

const sectionIds = (ctx: VoiceActionContext) =>
  ctx.session.sidebarPreferences
    .snapshot()
    .data?.sections.map(({ id }) => id) ?? [];

const sectionFilter = (ctx: VoiceActionContext, sectionKey: string) =>
  ctx.session.sidebarPreferences.snapshot().data?.filters?.[
    sectionPreferenceKey(sectionKey)
  ] ?? "all";

const sectionSort = (ctx: VoiceActionContext, sectionKey: string) =>
  ctx.session.sidebarPreferences.snapshot().data?.sort?.[
    sectionPreferenceKey(sectionKey)
  ];

/** Its sidebar section element, as the inventory renders it. */
export function sectionElement(
  sectionKey: string,
  root: ParentNode | undefined = typeof document === "undefined"
    ? undefined
    : document,
) {
  return root?.querySelector<HTMLDetailsElement>(
    `[data-sidebar-section="${CSS.escape(sectionKey)}"] details`,
  );
}

/** Opens or closes a section as clicking its header does; the header's own
 * handler saves the collapsed state.
 * KNOWN HACK (proof of concept): collapsed state lives in the sidebar
 * component's `useSidebarView`, which no voice-reachable owner exposes, so
 * this drives the DOM. Replace with a published sidebar callback, as
 * `ChannelNavigationProvider` publishes mute and lifecycle. */
export function toggleSection(
  sectionKey: string,
  open: boolean,
  root?: ParentNode,
) {
  const details = sectionElement(sectionKey, root);
  if (!details) return false;
  if (details.open !== open) details.querySelector("summary")?.click();
  return true;
}

const NOT_CHANNEL: readonly VoiceThing["kind"][] = [
  "nothing",
  "section",
  "message",
  "person",
  "agent",
  "thread",
  "community",
];

type SectionVariant = Readonly<{
  /** The sentence for the section, or for "a section" when none is bound. */
  describe: (section: string | undefined) => string;
  available: (ctx: VoiceActionContext, sectionKey: string) => boolean;
  /** When no section is hovered: is any section a valid target? */
  anyAvailable?: (ctx: VoiceActionContext) => boolean;
  summary: (section: string) => string;
  run: (
    ctx: VoiceActionContext,
    section: VoiceEntity,
    env: VoiceActionEnv,
  ) => Promise<void> | void;
}>;

/** Hovered kinds that aren't a section: there the section is found by name. */
const NOT_SECTION: readonly VoiceThing["kind"][] = [
  "nothing",
  "channel",
  "message",
  "person",
  "agent",
  "thread",
  "community",
];

/** A section action on the hovered section, plus, when `global`, the same
 * action with the section named aloud ("show only unreads in Work"). The
 * global form never binds while a section is hovered, so the two never
 * compete. */
function sectionAction(
  id: string,
  variant: SectionVariant,
  global: boolean,
): AppVoiceAction[] {
  const run: AppVoiceAction["run"] = ({ ctx, owner, target }, env) => {
    const section = owner?.kind === "section" ? owner : target;
    if (!section) throw new Error("No section selected.");
    return variant.run(ctx, section, env);
  };
  const summary: AppVoiceAction["summary"] = ({ owner, target }) =>
    variant.summary((owner?.kind === "section" ? owner : target)?.label ?? "");
  const hovered: AppVoiceAction = {
    id,
    owner: "section",
    confirm: "none",
    available: (ctx, { hoveredRole, bound }) =>
      hoveredRole === "owner" && !!bound && variant.available(ctx, bound.id),
    describe: ({ bound }) => variant.describe(bound?.label),
    summary,
    run,
  };
  if (!global) return [hovered];
  return [
    hovered,
    {
      id: `${id}.named`,
      owner: null,
      target: "section",
      whenHovered: NOT_SECTION,
      confirm: "none",
      available: (ctx) => variant.anyAvailable?.(ctx) ?? true,
      describe: () => variant.describe(undefined),
      summary,
      run,
    },
  ];
}

const filterAction = (
  id: string,
  mode: Exclude<SidebarFilterMode, "active">,
  describe: (section: string | undefined) => string,
) =>
  sectionAction(
    id,
    {
      describe,
      available: (ctx, key) =>
        ctx.session.sidebarPreferences.filterWritable &&
        !!ctx.session.sidebarPreferences.snapshot().data &&
        sectionFilter(ctx, key) !== mode,
      anyAvailable: (ctx) =>
        ctx.session.sidebarPreferences.filterWritable &&
        !!ctx.session.sidebarPreferences.snapshot().data,
      summary: (section) =>
        mode === "unreads"
          ? `Show only unreads in ${section}`
          : `Show everything in ${section}`,
      run: async (ctx, section, env) => {
        await ctx.session.sidebarPreferences.setFilter(
          sectionPreferenceKey(section.id),
          mode,
          sectionIds(ctx),
        );
        env.notify(
          mode === "unreads"
            ? `${section.label} shows only unreads`
            : `${section.label} shows everything`,
          "success",
        );
      },
    },
    true,
  );

const sortAction = (id: string, mode: SidebarSortMode, label: string) =>
  sectionAction(
    id,
    {
      describe: (section) => `Sort ${section ?? "a sidebar section"} ${label}`,
      available: (ctx, key) =>
        ctx.session.sidebarPreferences.sortWritable &&
        !!ctx.session.sidebarPreferences.snapshot().data &&
        sectionSort(ctx, key) !== mode,
      summary: (section) => `Sort ${section} ${label}`,
      run: (ctx, section, env) => {
        // The section menu's Sort fires and forgets the same write.
        void ctx.session.sidebarPreferences
          .setSort(sectionPreferenceKey(section.id), mode, sectionIds(ctx))
          .catch(() => env.notify("Couldn’t save the sort.", "error"));
        env.notify(`Sorted ${section.label} ${label}`, "success");
      },
    },
    false,
  );

const collapseAction = (id: string, open: boolean) =>
  sectionAction(
    id,
    {
      describe: (section) =>
        open
          ? `Expand ${section ?? "a sidebar section"} (show its channels)`
          : `Collapse ${section ?? "a sidebar section"} (hide its channels)`,
      available: (_ctx, key) => {
        const details = sectionElement(key);
        return !!details && details.open !== open;
      },
      summary: (section) => `${open ? "Expand" : "Collapse"} ${section}`,
      run: (_ctx, section) => {
        if (!toggleSection(section.id, open))
          throw new Error(`${section.label} isn’t in the sidebar.`);
      },
    },
    true,
  );

// Names said aloud, extracted by rule: Jev picks among options and can't
// write text. Every action using these confirms, showing the name first.
const POLITE =
  /^(?:(?:please|ok(?:ay)?|hey|so|um+|uh+)[,\s]+)*(?:(?:can|could|would)\s+you\s+)?/i;
/** Words that only point at the section being named, never part of it. */
const POINTER =
  /^(?:(?:the|this|that|it|my)\s+)?(?:(?:one|section|group|folder|sidebar\s+section)\s+)?/i;
const NAMES_IT = /\b(?:to|as|called|named|into)\s+(.+)$/i;

const said = (spoken: string) =>
  spoken
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .replace(POLITE, "");

/** "rename this to Launch", "rename this one to bots", "call it Ops",
 * "rename Work as Weekend", "rename this section fun stuff". */
export function extractRenameText(spoken: string): string | undefined {
  const text = said(spoken);
  const verb =
    /^(?:rename|re-?name|call|name|retitle|change\s+(?:the\s+)?name\s+(?:of\s+)?)\s*/i;
  if (!verb.test(text)) {
    // No rename verb: only an explicit "to X" / "called X" names it.
    return sectionName(NAMES_IT.exec(text)?.[1]);
  }
  const rest = text.replace(verb, "");
  const named = NAMES_IT.exec(rest)?.[1];
  // "rename this section fun stuff": drop what points at the section.
  return sectionName(named ?? rest.replace(POINTER, ""));
}

/** "move this into a new section called Voice", "make a new section for
 * hackathon", "new section customers", "add buzz community". */
export function extractNewSectionName(spoken: string): string | undefined {
  const text = said(spoken);
  const named = /\b(?:called|named|titled)\s+(.+)$/i.exec(text)?.[1];
  if (named) return sectionName(named);
  const kind = "(?:section|group|folder)";
  const afterKind = new RegExp(
    `\\b(?:new\\s+)?(?:sidebar\\s+)?${kind}\\s+(?:for\\s+|of\\s+)?(.+)$`,
    "i",
  ).exec(text)?.[1];
  if (afterKind) return sectionName(afterKind);
  // "add buzz community": the verb and its article, then the name.
  const bare =
    /^(?:add|create|make|start|new)(?:\s+me)?\s+(?:(?:a|an|the)\s+)?(?:new\s+)?(.+)$/i.exec(
      text,
    )?.[1];
  // "create a section" names nothing.
  return bare && !new RegExp(`^(?:sidebar\\s+)?${kind}$`, "i").test(bare)
    ? sectionName(bare)
    : undefined;
}

/** Trims quotes and spacing; an all-lowercase transcript gets title case,
 * as a typed section name would ("q4 planning" → "Q4 Planning"). */
export function sectionName(raw: string | undefined) {
  const name = raw
    ?.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return undefined;
  return name === name.toLowerCase()
    ? name.replace(
        /(^|\s)(\p{L})/gu,
        (_, space, letter) => `${space}${letter.toUpperCase()}`,
      )
    : name;
}

export const sectionVoiceActions: readonly AppVoiceAction[] = [
  {
    id: "section.create",
    owner: null,
    target: "text",
    // A hovered channel offers "move it into a new section" instead.
    whenHovered: NOT_CHANNEL,
    // The name comes from the transcript: always shown before it applies.
    confirm: "confirm",
    available: (ctx) => {
      const prefs = ctx.session.sidebarPreferences;
      return prefs.sectionCreationWritable && !!prefs.snapshot().data;
    },
    extractText: (spoken) => extractNewSectionName(spoken),
    describe: () => "Create a new sidebar section",
    summary: ({ text }) => `Create section “${text ?? ""}”`,
    run: async ({ ctx, text }, env) => {
      const name = text?.trim();
      if (!name) throw new Error("Say the new section's name.");
      await ctx.session.sidebarPreferences.createSection({
        id: crypto.randomUUID(),
        name,
      });
      env.notify(`Created ${name}`, "success");
    },
  },
  {
    id: "section.rename",
    owner: "section",
    target: "text",
    // The name comes from the transcript: always shown before it applies.
    confirm: "confirm",
    available: (ctx, { hoveredRole, bound }) =>
      hoveredRole === "owner" &&
      !!bound?.id.startsWith("group:") &&
      ctx.session.sidebarPreferences.sectionRenameWritable,
    extractText: (spoken) => extractRenameText(spoken),
    describe: ({ bound }) => `Rename ${bound?.label ?? "this section"}`,
    summary: ({ owner, text }) =>
      `Rename ${owner?.label ?? "section"} to “${text ?? ""}”`,
    run: async ({ ctx, owner, text }, env) => {
      const name = text?.trim();
      if (!owner?.id.startsWith("group:") || !name)
        throw new Error("Say the section's new name.");
      const sectionId = owner.id.slice("group:".length);
      const current = ctx.session.sidebarPreferences
        .snapshot()
        .data?.sections.find(({ id }) => id === sectionId)?.name;
      await ctx.session.sidebarPreferences.renameSection(
        sectionId,
        name,
        current,
      );
      env.notify(`Renamed to ${name}`, "success");
    },
  },
  ...filterAction(
    "section.show_unreads",
    "unreads",
    (section) =>
      `Show only unread channels in ${section ?? "a sidebar section"}`,
  ),
  ...filterAction(
    "section.show_all",
    "all",
    (section) =>
      `Show all channels in ${section ?? "a sidebar section"} (clear its filter)`,
  ),
  ...sortAction("section.sort_alpha", "alpha", "A to Z"),
  ...sortAction("section.sort_recent", "recent", "by most recent"),
  ...collapseAction("section.collapse", false),
  ...collapseAction("section.expand", true),
];

// ---------------------------------------------------------------------------
// Community
// ---------------------------------------------------------------------------

export const communityVoiceActions: readonly AppVoiceAction[] = [
  {
    id: "community.mark_all_read",
    owner: null,
    // Bulk: always asks first, never on partial speech.
    confirm: "confirm",
    available: (ctx) => frontierSync(ctx),
    describe: () => "Mark everything in this community as read",
    summary: () => "Mark all as read",
    run: async ({ ctx }, env) => {
      await ctx.session.unread.markAllChannelsRead().then(
        () => env.notify("Marked all as read.", "success"),
        () => env.notify("Couldn’t mark everything as read.", "error"),
      );
    },
  },
];

export const sidebarVoiceActions: readonly AppVoiceAction[] = [
  ...channelRowVoiceActions,
  ...sectionVoiceActions,
  ...communityVoiceActions,
];
