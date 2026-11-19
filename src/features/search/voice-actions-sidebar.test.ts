// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { matchActionBindings, type VoiceEntity } from "./voice-actions";
import type {
  AppVoiceAction,
  VoiceActionContext,
  VoiceActionEnv,
} from "./voice-actions-app";
import {
  extractNewSectionName,
  extractRenameText,
  sectionPreferenceKey,
  sidebarVoiceActions,
  toggleSection,
} from "./voice-actions-sidebar";
import type { VoiceThing } from "./voice-context";

vi.mock("../../shared/clipboard", () => ({
  writeClipboardText: vi.fn(() => Promise.resolve()),
}));
const { writeClipboardText } = await import("../../shared/clipboard");

const VIEWER = "a".repeat(64);
const CHANNEL_ID = "11111111-1111-4111-8111-111111111111";
const channel = (extra: Partial<ChannelSummary> = {}) =>
  ({
    id: CHANNEL_ID,
    name: "general",
    channelType: "stream",
    members: [VIEWER],
    owners: ["b".repeat(64)],
    viewerRole: "member",
    ...extra,
  }) as ChannelSummary;

type Prefs = {
  sections: { id: string; name: string }[];
  muted: string[];
  starred: string[];
  assignments: Record<string, string>;
  filters?: Record<string, string>;
  sort?: Record<string, string>;
};

function fixture({
  prefs = { sections: [], muted: [], starred: [], assignments: {} },
  channels = [channel()],
  unread = { manual: "none", observedCount: 0 },
  capability = "frontier-sync",
}: {
  prefs?: Prefs | undefined;
  channels?: ChannelSummary[];
  unread?: { manual: string; observedCount?: number };
  capability?: string;
} = {}) {
  const sidebarPreferences = {
    writable: true,
    starWritable: true,
    muteWritable: true,
    filterWritable: true,
    sortWritable: true,
    sectionCreationWritable: true,
    sectionRenameWritable: true,
    snapshot: () => ({ data: prefs }),
    setMute: vi.fn(() => Promise.resolve([])),
    setFilter: vi.fn(() => Promise.resolve()),
    setSort: vi.fn(() => Promise.resolve()),
    createSection: vi.fn(() => Promise.resolve()),
    createAndAssign: vi.fn(() => Promise.resolve()),
    renameSection: vi.fn(() => Promise.resolve()),
  };
  const session = {
    viewer: VIEWER,
    channels: { list: () => ({ channels }) },
    channelLifecycle: { available: true },
    sidebarPreferences,
    unread: {
      sync: () => ({ capability }),
      snapshot: vi.fn(() => unread),
      markChannelRead: vi.fn(() => Promise.resolve({})),
      markUnreadLocal: vi.fn(() => Promise.resolve({})),
      markAllChannelsRead: vi.fn(() => Promise.resolve([])),
    },
  };
  const env = {
    notify: vi.fn(),
    navigation: { open: vi.fn() },
    communities: {},
  } as unknown as VoiceActionEnv;
  const ctx = (hovered: VoiceThing) =>
    ({
      session: session as unknown as RelaySession,
      hovered,
      resolveName: (_: string, fallback: string) => fallback,
    }) as VoiceActionContext;
  return { session, sidebarPreferences, env, ctx };
}

const hoveredChannel: VoiceThing = {
  kind: "channel",
  id: CHANNEL_ID,
  name: "general",
  channelType: "stream",
  label: "#general",
};
const hoveredSection = (id: string, name: string): VoiceThing => ({
  kind: "section",
  id,
  name,
  label: `section ${name}`,
});
const nothing: VoiceThing = { kind: "nothing", label: "nothing" };
const work: VoiceEntity = {
  kind: "section",
  id: "group:work",
  label: "Work",
  meta: { sectionId: "work" },
};
const entities = { section: [work] };

/** The action ids that would be offered for this hover. */
function offered(ctx: VoiceActionContext) {
  return matchActionBindings(
    sidebarVoiceActions,
    ctx.hovered,
    entities,
    (action, role) => (action as AppVoiceAction).available?.(ctx, role) ?? true,
  ).map(({ action }) => action.id);
}

const bound = (
  actions: readonly AppVoiceAction[],
  id: string,
  ctx: VoiceActionContext,
) => {
  const binding = matchActionBindings(actions, ctx.hovered, entities).find(
    ({ action }) => action.id === id,
  );
  if (!binding) throw new Error(`${id} not offered`);
  return { action: binding.action as AppVoiceAction, binding };
};

async function run(
  id: string,
  ctx: VoiceActionContext,
  env: VoiceActionEnv,
  extra: { target?: VoiceEntity; text?: string } = {},
) {
  const { action, binding } = bound(sidebarVoiceActions, id, ctx);
  const owner = binding.hoveredRole === "owner" ? binding.bound : undefined;
  await action.run(
    {
      ctx,
      ...(owner ? { owner } : {}),
      ...(binding.hoveredRole === "target" ? { owner: extra.target } : {}),
      ...(binding.hoveredRole === "none" && extra.target
        ? { target: extra.target }
        : {}),
      ...(extra.text ? { text: extra.text } : {}),
      spoken: "",
    },
    env,
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("channel row actions", () => {
  it("offers mute or unmute, never both", () => {
    const muted = fixture({
      prefs: {
        sections: [],
        muted: [CHANNEL_ID],
        starred: [],
        assignments: {},
      },
    });
    expect(offered(fixture().ctx(hoveredChannel))).toContain("channel.mute");
    expect(offered(fixture().ctx(hoveredChannel))).not.toContain(
      "channel.unmute",
    );
    expect(offered(muted.ctx(hoveredChannel))).toContain("channel.unmute");
    expect(offered(muted.ctx(hoveredChannel))).not.toContain("channel.mute");
  });

  it("mutes through the sidebar's optimistic mute when it is there", async () => {
    const { ctx, env, sidebarPreferences } = fixture();
    const change = vi.fn();
    const withNavigation = {
      ...env,
      channelNavigation: { mute: { change }, openLifecycle: vi.fn() },
    } as VoiceActionEnv;
    await run("channel.mute", ctx(hoveredChannel), withNavigation);
    expect(change).toHaveBeenCalledWith(CHANNEL_ID, "general", true);
    expect(sidebarPreferences.setMute).not.toHaveBeenCalled();
  });

  it("falls back to the saved mute without the sidebar", async () => {
    const { ctx, env, sidebarPreferences } = fixture();
    await run("channel.mute", ctx(hoveredChannel), env);
    expect(sidebarPreferences.setMute).toHaveBeenCalledWith(CHANNEL_ID, true);
  });

  it("offers mute only where mutes are writable", () => {
    const { ctx, sidebarPreferences } = fixture();
    sidebarPreferences.muteWritable = false;
    expect(offered(ctx(hoveredChannel))).not.toContain("channel.mute");
  });

  it("marks read when unread, unread when read, as the row menu does", async () => {
    const reading = fixture({ unread: { manual: "none", observedCount: 3 } });
    expect(offered(reading.ctx(hoveredChannel))).toContain("channel.mark_read");
    expect(offered(reading.ctx(hoveredChannel))).not.toContain(
      "channel.mark_unread",
    );
    await run("channel.mark_read", reading.ctx(hoveredChannel), reading.env);
    expect(reading.session.unread.markChannelRead).toHaveBeenCalledWith(
      CHANNEL_ID,
    );

    const read = fixture();
    await run("channel.mark_unread", read.ctx(hoveredChannel), read.env);
    expect(read.session.unread.markUnreadLocal).toHaveBeenCalledWith({
      kind: "channel",
      channelId: CHANNEL_ID,
    });
  });

  it("offers no read actions without frontier sync", () => {
    const { ctx } = fixture({ capability: "local" });
    const ids = offered(ctx(hoveredChannel));
    expect(ids).not.toContain("channel.mark_read");
    expect(ids).not.toContain("channel.mark_unread");
  });

  it("copies the same link as Copy link", async () => {
    const { ctx, env } = fixture();
    await run("channel.copy_link", ctx(hoveredChannel), env);
    expect(writeClipboardText).toHaveBeenCalledWith(
      `buzz://channel/${CHANNEL_ID}`,
    );
    expect(env.notify).toHaveBeenCalledWith("Link copied.", "success");
  });

  it("leaves and archives only through the lifecycle dialog", async () => {
    const { ctx, env } = fixture({
      channels: [channel({ owners: [VIEWER], viewerRole: "owner" })],
    });
    const openLifecycle = vi.fn();
    const withNavigation = {
      ...env,
      channelNavigation: { mute: { change: vi.fn() }, openLifecycle },
    } as VoiceActionEnv;
    expect(offered(ctx(hoveredChannel))).toContain("channel.archive");
    await run("channel.archive", ctx(hoveredChannel), withNavigation);
    expect(openLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ id: CHANNEL_ID }),
      "archive",
    );
    await expect(
      run("channel.archive", ctx(hoveredChannel), env),
    ).rejects.toThrow("aren't available");
  });

  it("offers no lifecycle action for a channel the viewer isn't in", () => {
    const { ctx } = fixture({ channels: [channel({ members: [] })] });
    const ids = offered(ctx(hoveredChannel));
    expect(ids).not.toContain("channel.leave");
    expect(ids).not.toContain("channel.archive");
  });

  it("creates a section from the spoken name and moves the channel in", async () => {
    const { ctx, env, sidebarPreferences } = fixture();
    await run("channel.move_to_new_section", ctx(hoveredChannel), env, {
      text: "Voice",
    });
    expect(sidebarPreferences.createAndAssign).toHaveBeenCalledWith(
      CHANNEL_ID,
      { id: expect.any(String), name: "Voice" },
    );
  });

  it("offers create-section, not move-to-new, for a hovered channel only", () => {
    const { ctx } = fixture();
    expect(offered(ctx(hoveredChannel))).toContain(
      "channel.move_to_new_section",
    );
    expect(offered(ctx(hoveredChannel))).not.toContain("section.create");
    expect(offered(ctx(nothing))).toContain("section.create");
  });
});

describe("section actions", () => {
  const prefs: Prefs = {
    sections: [{ id: "work", name: "Work" }],
    muted: [],
    starred: [],
    assignments: {},
    filters: { "section:work": "unreads" },
  };

  it("saves filters and sorts under the section's preference key", async () => {
    const { ctx, env, sidebarPreferences } = fixture({ prefs });
    expect(sectionPreferenceKey("group:work")).toBe("section:work");
    expect(sectionPreferenceKey("dms")).toBe("dms");
    await run(
      "section.show_all",
      ctx(hoveredSection("group:work", "Work")),
      env,
    );
    expect(sidebarPreferences.setFilter).toHaveBeenCalledWith(
      "section:work",
      "all",
      ["work"],
    );
    await run("section.sort_alpha", ctx(hoveredSection("dms", "DMs")), env);
    expect(sidebarPreferences.setSort).toHaveBeenCalledWith("dms", "alpha", [
      "work",
    ]);
  });

  it("offers only the filter the section isn't already showing", () => {
    const { ctx } = fixture({ prefs });
    const ids = offered(ctx(hoveredSection("group:work", "Work")));
    expect(ids).toContain("section.show_all");
    expect(ids).not.toContain("section.show_unreads");
  });

  it("binds the hovered section, or finds a named one, never both", () => {
    const { ctx } = fixture({ prefs });
    const hovered = offered(ctx(hoveredSection("group:work", "Work")));
    expect(hovered).toContain("section.show_all");
    expect(hovered).not.toContain("section.show_all.named");
    const away = offered(ctx(hoveredChannel));
    expect(away).toContain("section.show_unreads.named");
    expect(away).not.toContain("section.show_unreads");
  });

  it("runs a named section's filter on the section Jev found", async () => {
    const { ctx, env, sidebarPreferences } = fixture({ prefs });
    await run("section.show_unreads.named", ctx(nothing), env, {
      target: work,
    });
    expect(sidebarPreferences.setFilter).toHaveBeenCalledWith(
      "section:work",
      "unreads",
      ["work"],
    );
  });

  it("renames only custom sections, with the name it expects", async () => {
    const { ctx, env, sidebarPreferences } = fixture({ prefs });
    expect(offered(ctx(hoveredSection("dms", "DMs")))).not.toContain(
      "section.rename",
    );
    await run(
      "section.rename",
      ctx(hoveredSection("group:work", "Work")),
      env,
      {
        text: "Launch",
      },
    );
    expect(sidebarPreferences.renameSection).toHaveBeenCalledWith(
      "work",
      "Launch",
      "Work",
    );
  });

  it("creates a section from the spoken name", async () => {
    const { ctx, env, sidebarPreferences } = fixture();
    await run("section.create", ctx(nothing), env, { text: "buzz community" });
    expect(sidebarPreferences.createSection).toHaveBeenCalledWith({
      id: expect.any(String),
      name: "buzz community",
    });
  });

  it("collapses and expands through the section header", () => {
    document.body.innerHTML = `<section data-sidebar-section="group:work"><details open><summary>Work</summary></details></section>`;
    const clicks = vi.fn();
    document.querySelector("summary")?.addEventListener("click", clicks);
    const { ctx } = fixture({ prefs });
    const ids = offered(ctx(hoveredSection("group:work", "Work")));
    expect(ids).toContain("section.collapse");
    expect(ids).not.toContain("section.expand");
    expect(toggleSection("group:work", true)).toBe(true);
    expect(clicks).not.toHaveBeenCalled();
    expect(toggleSection("group:work", false)).toBe(true);
    expect(clicks).toHaveBeenCalledOnce();
    expect(toggleSection("group:missing", false)).toBe(false);
  });
});

describe("community actions", () => {
  it("asks before marking everything read", async () => {
    const { ctx, env, session } = fixture();
    const { action } = bound(
      sidebarVoiceActions,
      "community.mark_all_read",
      ctx(nothing),
    );
    expect(action.confirm).toBe("confirm");
    await run("community.mark_all_read", ctx(nothing), env);
    expect(session.unread.markAllChannelsRead).toHaveBeenCalledOnce();
    expect(env.notify).toHaveBeenCalledWith("Marked all as read.", "success");
  });
});

describe("spoken names", () => {
  it.each([
    ["move this into a new section called Voice", "Voice"],
    ["put it in a new section named Launch prep.", "Launch prep"],
    ["new section for agents", "Agents"],
    ["add buzz community", "Buzz Community"],
    ["create a section called “Work”", "Work"],
    ["create a section called reading list", "Reading List"],
    ["make a new section for hackathon", "Hackathon"],
    ["new section customers", "Customers"],
    ["create a section named experiments", "Experiments"],
    ["add a section called q4 planning", "Q4 Planning"],
    ["make me a section named launch week", "Launch Week"],
    ["please start a new section called writing", "Writing"],
    ["move this to a new section voice", "Voice"],
  ])("new section from %j", (spoken, name) => {
    expect(extractNewSectionName(spoken)).toBe(name);
  });

  it.each([
    "create a section",
    "make a new section",
    "move this into a new section",
  ])("no name in %j", (spoken) => {
    expect(extractNewSectionName(spoken)).toBeUndefined();
  });

  it.each([
    ["rename this to Launch", "Launch"],
    ["rename this one to bots", "Bots"],
    ["call it Ops", "Ops"],
    ["rename Work as Weekend", "Weekend"],
    ["rename this to someday", "Someday"],
    ["rename this section fun stuff", "Fun Stuff"],
    ["rename this to back to school", "Back To School"],
    ["could you rename it to Q4 Launch?", "Q4 Launch"],
  ])("rename from %j", (spoken, name) => {
    expect(extractRenameText(spoken)).toBe(name);
  });

  it("asks before applying any name taken from the transcript", () => {
    const named = sidebarVoiceActions.filter(({ target }) => target === "text");
    expect(named.map(({ id }) => id).sort()).toEqual([
      "channel.move_to_new_section",
      "section.create",
      "section.rename",
    ]);
    for (const action of named) expect(action.confirm).toBe("confirm");
  });
});
