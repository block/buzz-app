// Voice actions on people, agents and yourself: message someone, open a
// profile, add someone to a channel (from either side), and set your
// availability. Each calls the operation its existing control calls.
import { newMessageTarget } from "../channel-navigation/new-message-route";
import { addChannelMember, canAddMembers } from "../channel-members/members";
import { messagePerson } from "../direct-messages/message-person";
import type { PresencePreference } from "../presence/activity";
import { profileTarget } from "../profiles/target";
import type { VoiceEntity } from "./voice-actions";
import type {
  AppVoiceAction,
  VoiceActionContext,
  VoiceActionEnv,
} from "./voice-actions-app";
import { channelOf } from "./voice-actions-sidebar";
import type { VoiceThing } from "./voice-context";

const pubkeyOf = (entity: VoiceEntity) =>
  (entity.meta?.pubkey as string | undefined) ?? entity.id;

const isAgent = (entity: VoiceEntity | undefined) =>
  entity?.kind === "agent" || entity?.meta?.isAgent === true;

/** Hovered kinds where a person is found by name instead. */
const NOT_PERSON: readonly VoiceThing["kind"][] = [
  "nothing",
  "channel",
  "section",
  "message",
  "thread",
  "community",
];

type PersonVariant = Readonly<{
  describe: (name: string | undefined) => string;
  available?: (ctx: VoiceActionContext) => boolean;
  summary: (name: string) => string;
  run: (
    ctx: VoiceActionContext,
    person: VoiceEntity,
    env: VoiceActionEnv,
  ) => Promise<void> | void;
}>;

/** The action on a hovered person, on a hovered agent, and, with neither
 * hovered, on someone named aloud ("message drone01"). */
function personAction(id: string, variant: PersonVariant): AppVoiceAction[] {
  const person = ({ owner, target }: Parameters<AppVoiceAction["run"]>[0]) =>
    owner?.kind === "person" || owner?.kind === "agent" ? owner : target;
  const run: AppVoiceAction["run"] = (invocation, env) => {
    const who = person(invocation);
    if (!who || !pubkeyOf(who)) throw new Error("No one was named.");
    return variant.run(invocation.ctx, who, env);
  };
  const summary: AppVoiceAction["summary"] = (invocation) =>
    variant.summary(person(invocation)?.label ?? "");
  const available = (ctx: VoiceActionContext) =>
    variant.available?.(ctx) ?? true;
  return (["person", "agent"] as const)
    .map(
      (owner): AppVoiceAction => ({
        id: owner === "person" ? id : `${id}.agent`,
        owner,
        confirm: "none",
        available: (ctx, { hoveredRole }) =>
          hoveredRole === "owner" && available(ctx),
        describe: ({ bound }) => variant.describe(bound?.label),
        summary,
        run,
      }),
    )
    .concat({
      id: `${id}.named`,
      owner: null,
      target: "person",
      whenHovered: NOT_PERSON,
      confirm: "none",
      available,
      describe: () => variant.describe(undefined),
      summary,
      run,
    });
}

const conversationScope = (ctx: VoiceActionContext) => {
  if (!ctx.scope) throw new Error("Not connected to a community.");
  return ctx.scope;
};

// ---------------------------------------------------------------------------
// Add someone to a channel: channel ← person, from either side
// ---------------------------------------------------------------------------

const channelMembers = (ctx: VoiceActionContext, entity: VoiceEntity) =>
  channelOf(ctx.session, entity)?.members ?? [];

const addable = (ctx: VoiceActionContext, channel: VoiceEntity | undefined) =>
  canAddMembers(ctx.session, channelOf(ctx.session, channel));

const addToChannel = (
  id: string,
  target: "person" | "agent",
): AppVoiceAction => ({
  id,
  owner: "channel",
  target,
  // Changes who can read the channel and notifies them: always asks first.
  confirm: "confirm",
  available: (ctx, { hoveredRole, bound }) =>
    hoveredRole === "owner"
      ? // From a hovered channel, `person` already includes agents.
        target === "person" && addable(ctx, bound)
      : hoveredRole === "target" &&
        !!bound &&
        ctx.session.channels
          .list()
          .channels.some(
            (channel) =>
              canAddMembers(ctx.session, channel) &&
              !channel.members?.includes(bound.id),
          ),
  filterSlot: (slot, entity, bound) =>
    slot === "channel"
      ? entity.meta?.channelType !== "dm" &&
        !(
          entity.meta?.channel as { members?: string[] } | undefined
        )?.members?.includes(bound ? pubkeyOf(bound) : "")
      : true,
  describe: ({ hoveredRole, bound }) =>
    hoveredRole === "owner"
      ? `Add someone to ${bound?.label ?? "this channel"}`
      : `Add ${bound?.label ?? "this person"} to a channel`,
  summary: ({ owner, target: who }) =>
    `Add ${who?.label ?? "someone"} to ${owner?.label ?? "channel"}`,
  run: async ({ ctx, owner, target: who }, env) => {
    if (!owner || !who)
      throw new Error("Both a channel and a person are needed.");
    const pubkey = pubkeyOf(who);
    if (!addable(ctx, owner))
      throw new Error(`You can't add people to ${owner.label}.`);
    if (channelMembers(ctx, owner).includes(pubkey)) {
      env.notify(`${who.label} is already in ${owner.label}`, "info");
      return;
    }
    await addChannelMember(
      ctx.session,
      owner.id,
      pubkey,
      new AbortController().signal,
    );
    env.notify(`Added ${who.label} to ${owner.label}`, "success");
  },
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const availability = (
  id: string,
  value: PresencePreference,
  sentence: string,
  done: string,
): AppVoiceAction => ({
  id,
  owner: null,
  confirm: "none",
  available: (ctx) => !!ctx.session.viewer,
  describe: () => sentence,
  summary: () => sentence,
  run: (_invocation, env) => {
    env.communities.presence.setPreference(value);
    env.notify(done, "success");
  },
});

export const peopleVoiceActions: readonly AppVoiceAction[] = [
  ...personAction("person.message", {
    describe: (name) =>
      `Send a direct message to ${name ?? "someone"} (open our DM)`,
    summary: (name) => `Message ${name}`,
    run: async (ctx, person, env) => {
      const pubkey = pubkeyOf(person);
      const scope = conversationScope(ctx);
      // Opens the DM, or a New message draft; nothing is sent.
      const destination = await messagePerson(
        ctx.session,
        pubkey,
        new AbortController().signal,
      );
      await env.navigation.open(
        "channelId" in destination
          ? {
              version: 1,
              kind: "conversation",
              scope,
              channelId: destination.channelId,
            }
          : newMessageTarget(scope, destination.draftTo),
      );
    },
  }),
  ...personAction("person.view_profile", {
    describe: (name) => `Show ${name ? `${name}'s` : "someone's"} profile`,
    available: (ctx) => !!ctx.activeChannelId,
    summary: (name) => `Show ${name}'s profile`,
    run: async (ctx, person, env) => {
      const target = profileTarget(pubkeyOf(person), {
        agent: isAgent(person),
      });
      if (!target || !ctx.activeChannelId)
        throw new Error("Open a conversation to show a profile beside it.");
      // A profile opens beside the open conversation, as clicking a name does.
      await env.navigation.open({
        version: 1,
        kind: "conversation",
        scope: conversationScope(ctx),
        channelId: ctx.activeChannelId,
        detail: { target },
      });
    },
  }),
  addToChannel("channel.add_person", "person"),
  addToChannel("channel.add_agent", "agent"),
  availability(
    "self.set_away",
    "away",
    "Set my availability to away",
    "You’re away",
  ),
  availability(
    "self.set_active",
    "auto",
    "Set my availability to active (I'm back)",
    "You’re active",
  ),
  availability(
    "self.set_offline",
    "offline",
    "Appear offline",
    "You appear offline",
  ),
];
