import { describe, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { matchActionBindings, type VoiceEntity } from "./voice-actions";
import type {
  AppVoiceAction,
  VoiceActionContext,
  VoiceActionEnv,
} from "./voice-actions-app";
import { peopleVoiceActions } from "./voice-actions-people";
import type { VoiceThing } from "./voice-context";

vi.mock("../channel-members/members", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channel-members/members")>()),
  addChannelMember: vi.fn(() => Promise.resolve()),
}));
const { addChannelMember } = await import("../channel-members/members");

const VIEWER = "a".repeat(64);
const ALICE = "c".repeat(64);
const AGENT = "d".repeat(64);
const CHANNEL_ID = "11111111-1111-4111-8111-111111111111";
const DM_ID = "22222222-2222-4222-8222-222222222222";
const scope = { viewer: VIEWER, communityOrigin: "https://example.org" };

const general = {
  id: CHANNEL_ID,
  name: "general",
  channelType: "stream",
  members: [VIEWER],
} as ChannelSummary;

function fixture({
  channels = [general],
  activeChannelId = CHANNEL_ID as string | null,
} = {}) {
  const session = {
    viewer: VIEWER,
    outbox: { supports: (kind: number) => kind === 9000 },
    channels: { list: () => ({ channels }) },
    directMessages: { open: vi.fn(() => Promise.resolve(DM_ID)) },
  };
  const setPreference = vi.fn();
  const env = {
    notify: vi.fn(),
    navigation: { open: vi.fn(() => Promise.resolve()) },
    communities: { presence: { setPreference } },
  } as unknown as VoiceActionEnv;
  const ctx = (hovered: VoiceThing) =>
    ({
      session: session as unknown as RelaySession,
      hovered,
      resolveName: (_: string, fallback: string) => fallback,
      scope,
      ...(activeChannelId ? { activeChannelId } : {}),
    }) as VoiceActionContext;
  return { session, env, ctx, setPreference };
}

const alice: VoiceEntity = {
  kind: "person",
  id: ALICE,
  label: "Alice",
  meta: { pubkey: ALICE, isAgent: false },
};
const generalEntity: VoiceEntity = {
  kind: "channel",
  id: CHANNEL_ID,
  label: "#general",
  meta: { channel: general, channelType: "stream" },
};
const entities = { person: [alice], channel: [generalEntity] };

const hoveredPerson: VoiceThing = {
  kind: "person",
  id: ALICE,
  name: "Alice",
  label: "Alice",
};
const hoveredAgent: VoiceThing = {
  kind: "agent",
  id: AGENT,
  name: "mbot",
  label: "mbot",
};
const hoveredChannel: VoiceThing = {
  kind: "channel",
  id: CHANNEL_ID,
  name: "general",
  channelType: "stream",
  label: "#general",
};
const nothing: VoiceThing = { kind: "nothing", label: "nothing" };

const bindings = (ctx: VoiceActionContext) =>
  matchActionBindings(
    peopleVoiceActions,
    ctx.hovered,
    entities,
    (a, role) => (a as AppVoiceAction).available?.(ctx, role) ?? true,
  );
const offered = (ctx: VoiceActionContext) =>
  bindings(ctx).map(({ action }) => action.id);

async function run(
  id: string,
  ctx: VoiceActionContext,
  env: VoiceActionEnv,
  found?: VoiceEntity,
) {
  const binding = bindings(ctx).find(({ action }) => action.id === id);
  if (!binding) throw new Error(`${id} not offered`);
  const action = binding.action as AppVoiceAction;
  const role = binding.hoveredRole;
  await action.run(
    {
      ctx,
      ...(role === "owner" ? { owner: binding.bound, target: found } : {}),
      ...(role === "target" ? { owner: found, target: binding.bound } : {}),
      ...(role === "none" ? { target: found } : {}),
      spoken: "",
    },
    env,
  );
}

describe("message someone", () => {
  it("binds exactly one message action per hover", () => {
    const { ctx } = fixture();
    const messaging = (thing: VoiceThing) =>
      offered(ctx(thing)).filter((id) => id.startsWith("person.message"));
    expect(messaging(hoveredPerson)).toEqual(["person.message"]);
    expect(messaging(hoveredAgent)).toEqual(["person.message.agent"]);
    expect(messaging(nothing)).toEqual(["person.message.named"]);
    expect(messaging(hoveredChannel)).toEqual(["person.message.named"]);
  });

  it("opens an existing DM without sending anything", async () => {
    const dm = {
      id: DM_ID,
      name: "Alice",
      channelType: "dm",
      participants: [ALICE],
    } as ChannelSummary;
    const { ctx, env, session } = fixture({ channels: [general, dm] });
    await run("person.message", ctx(hoveredPerson), env);
    expect(session.directMessages.open).toHaveBeenCalledWith(
      [ALICE],
      expect.any(AbortSignal),
    );
    expect(env.navigation.open).toHaveBeenCalledWith({
      version: 1,
      kind: "conversation",
      scope,
      channelId: DM_ID,
    });
  });

  it("opens a New message draft to someone without a DM", async () => {
    const { ctx, env, session } = fixture();
    await run("person.message.named", ctx(nothing), env, alice);
    expect(session.directMessages.open).not.toHaveBeenCalled();
    expect(env.navigation.open).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "page",
        route: expect.objectContaining({
          params: expect.objectContaining({ kind: "new-message", to: ALICE }),
        }),
      }),
    );
  });
});

describe("profiles", () => {
  it("opens a profile beside the open conversation", async () => {
    const { ctx, env } = fixture();
    await run("person.view_profile.agent", ctx(hoveredAgent), env);
    expect(env.navigation.open).toHaveBeenCalledWith({
      version: 1,
      kind: "conversation",
      scope,
      channelId: CHANNEL_ID,
      detail: { target: `buzz:agent-profile:${AGENT}` },
    });
  });

  it("isn't offered without an open conversation", () => {
    const { ctx } = fixture({ activeChannelId: null });
    expect(offered(ctx(hoveredPerson))).not.toContain("person.view_profile");
  });
});

describe("add someone to a channel", () => {
  it("binds from the channel and from the person, and asks first", () => {
    const { ctx } = fixture();
    const fromChannel = bindings(ctx(hoveredChannel)).filter(({ action }) =>
      action.id.startsWith("channel.add_"),
    );
    expect(fromChannel.map(({ action }) => action.id)).toEqual([
      "channel.add_person",
    ]);
    expect(fromChannel[0]?.missingSlot).toBe("person");
    expect(fromChannel[0]?.action.confirm).toBe("confirm");
    const fromPerson = bindings(ctx(hoveredPerson)).filter(({ action }) =>
      action.id.startsWith("channel.add_"),
    );
    expect(fromPerson.map(({ action }) => action.id)).toEqual([
      "channel.add_person",
    ]);
    expect(fromPerson[0]?.missingSlot).toBe("channel");
    expect(offered(ctx(hoveredAgent))).toContain("channel.add_agent");
  });

  it("adds the person through the members owner", async () => {
    const { ctx, env } = fixture();
    await run("channel.add_person", ctx(hoveredPerson), env, generalEntity);
    expect(addChannelMember).toHaveBeenCalledWith(
      expect.anything(),
      CHANNEL_ID,
      ALICE,
      expect.any(AbortSignal),
    );
  });

  it("isn't offered where the viewer can't add members", () => {
    const { ctx } = fixture({ channels: [{ ...general, members: [] }] });
    expect(offered(ctx(hoveredChannel))).not.toContain("channel.add_person");
    expect(offered(ctx(hoveredPerson))).not.toContain("channel.add_person");
  });

  it("doesn't re-add someone already there", async () => {
    vi.mocked(addChannelMember).mockClear();
    const { ctx, env } = fixture({
      channels: [{ ...general, members: [VIEWER, ALICE] }],
    });
    await run("channel.add_person", ctx(hoveredChannel), env, alice);
    expect(addChannelMember).not.toHaveBeenCalled();
    expect(env.notify).toHaveBeenCalledWith(
      "Alice is already in #general",
      "info",
    );
  });
});

describe("availability", () => {
  it.each([
    ["self.set_away", "away"],
    ["self.set_active", "auto"],
    ["self.set_offline", "offline"],
  ])("%s sets presence to %s", async (id, value) => {
    const { ctx, env, setPreference } = fixture();
    await run(id, ctx(nothing), env);
    expect(setPreference).toHaveBeenCalledWith(value);
  });
});
