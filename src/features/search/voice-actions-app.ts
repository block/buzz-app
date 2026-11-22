// Shared runtime context, environment, and entity extraction for app voice actions.
import { canMessageAgent } from "../agents/choices";
import type { Communities } from "../communities/service";
import type { Navigation } from "../navigation/controller";
import type { NavigationScope } from "../navigation/targets";
import type { ChannelLifecycleAction } from "../relay/channel-lifecycle-protocol";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type {
  VoiceAction,
  VoiceEntity,
  VoiceSlotEntities,
} from "./voice-actions";
import { channelDisplayName, type VoiceThing } from "./voice-context";

export type ChannelNavigationActions = Readonly<{
  mute: { change(channelId: string, name: string, muted: boolean): void };
  openLifecycle(channel: ChannelSummary, action: ChannelLifecycleAction): void;
}>;

export type VoiceActionContext = Readonly<{
  session: RelaySession;
  hovered: VoiceThing;
  resolveName: (
    pubkey: string,
    fallback: string,
    among?: readonly string[],
  ) => string;
  community?: string | undefined;
  scope?: NavigationScope | undefined;
  activeChannelId?: string | undefined;
  channelNavigation?: ChannelNavigationActions | undefined;
}>;

export type VoiceActionEnv = Readonly<{
  navigation: Navigation;
  communities: Communities;
  channelNavigation?: ChannelNavigationActions | undefined;
  notify: (
    title: string,
    tone: "success" | "error" | "info",
    action?: { label: string; onClick(): void; timeout?: number },
  ) => void;
}>;

export type AppVoiceAction = VoiceAction<VoiceActionContext, VoiceActionEnv>;

const MAX_ENTITIES = 200;

/** Default quick-reaction emojis available as closed-set slot candidates. */
const QUICK_EMOJIS: readonly { id: string; label: string }[] = [
  { id: "👍", label: "👍 thumbs up" },
  { id: "❤️", label: "❤️ heart" },
  { id: "😂", label: "😂 laughing" },
  { id: "🎉", label: "🎉 party / celebrate" },
  { id: "👀", label: "👀 eyes" },
  { id: "🚀", label: "🚀 rocket" },
  { id: "🙏", label: "🙏 thanks / pray" },
  { id: "💯", label: "💯 100" },
  { id: "🔥", label: "🔥 fire" },
  { id: "✅", label: "✅ check mark" },
  { id: "👎", label: "👎 thumbs down" },
  { id: "🤔", label: "🤔 thinking" },
];

export function isWritableChannelDestination(channel: ChannelSummary): boolean {
  return (
    (channel.channelType === "stream" || channel.channelType === "forum") &&
    !channel.huddle &&
    !channel.metadataPending &&
    !channel.pending &&
    !channel.cached &&
    !channel.readOnly &&
    !channel.archived
  );
}

/** Collects closed-set entity candidates from in-memory session state (never reads relay). */
export function sessionVoiceEntities(
  session: RelaySession,
  resolveName: (
    pubkey: string,
    fallback: string,
    among?: readonly string[],
  ) => string,
): VoiceSlotEntities {
  const allChannels = session.channels.list().channels;
  const prefs = session.sidebarPreferences.snapshot().data;
  const starredSet = new Set(prefs?.starred ?? []);
  const assignments = prefs?.assignments ?? {};
  const profiles = session.profiles.snapshot();

  // 1. Channels (most recently active first).
  const visibleChannels = allChannels
    .filter(
      (c) =>
        !c.archived &&
        !c.huddle &&
        c.channelType !== "system" &&
        (!c.hidden || c.channelType === "dm"),
    )
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    .slice(0, MAX_ENTITIES);

  const channelEntities: VoiceEntity[] = visibleChannels.map((channel) => {
    const name = channelDisplayName(channel, session, resolveName);
    const starred = starredSet.has(channel.id);
    const assigned = assignments[channel.id];
    const sectionKey = starred
      ? "starred"
      : assigned
        ? `group:${assigned}`
        : channel.channelType === "dm"
          ? "dms"
          : "channels";
    return {
      kind: "channel",
      id: channel.id,
      label:
        channel.channelType === "dm"
          ? `DM with ${name}`
          : channel.channelType === "solo"
            ? name
            : `#${name}`,
      ...(channel.channelType ? { detail: channel.channelType } : {}),
      soundsLikeName: name,
      meta: {
        channel,
        name,
        channelType: channel.channelType,
        sectionKey,
        starred,
      },
    };
  });

  // 2. Sidebar sections (custom groups + default ungrouped destinations; Starred
  // is intentionally omitted so `channel.star` and `channel.move_to_section`
  // never compete on "pin to favorites").
  const sectionEntities: VoiceEntity[] = [
    ...(prefs?.sections ?? []).map((section) => ({
      kind: "section" as const,
      id: `group:${section.id}`,
      label: section.name,
      detail: "Sidebar section",
      soundsLikeName: section.name,
      meta: { sectionId: section.id, name: section.name },
    })),
    {
      kind: "section" as const,
      id: "channels",
      label: "Channels",
      detail: "Default channels list",
      soundsLikeName: "Channels",
      meta: { name: "Channels" },
    },
    {
      kind: "section" as const,
      id: "dms",
      label: "Direct messages",
      detail: "Default DMs list",
      soundsLikeName: "Direct messages",
      meta: { name: "Direct messages" },
    },
  ];

  // 3. People & messageable agents (ordered by DM recency, then members, then directory).
  const seenPeople = new Set<string>();
  const personEntities: VoiceEntity[] = [];
  const agentChoices = session.agentChoices.snapshot().identities;
  const agentChoiceMap = new Map(agentChoices.map((a) => [a.pubkey, a]));

  const pushPerson = (pubkey: string, among?: readonly string[]) => {
    if (!pubkey || pubkey === session.viewer || seenPeople.has(pubkey)) return;
    const profile = profiles.get(pubkey);
    const choice = agentChoiceMap.get(pubkey);
    const isAgent = Boolean(choice || profile?.isAgent);
    if (isAgent && choice && !canMessageAgent(choice)) return;
    const fallback = choice?.name ?? profile?.name ?? pubkey.slice(0, 10);
    const name = resolveName(pubkey, fallback, among);
    if (!name.trim()) return;
    seenPeople.add(pubkey);
    personEntities.push({
      kind: "person",
      id: pubkey,
      label: name,
      detail: isAgent ? "Agent" : "Person",
      soundsLikeName: name,
      meta: { pubkey, name, isAgent },
    });
  };

  for (const ch of visibleChannels) {
    const peer =
      ch.channelType === "dm" && ch.participants?.length === 1
        ? ch.participants[0]
        : undefined;
    if (peer) {
      pushPerson(peer, ch.participants);
    }
  }
  for (const ch of visibleChannels) {
    for (const member of ch.members ?? []) {
      if (personEntities.length >= MAX_ENTITIES) break;
      pushPerson(member, ch.members);
    }
  }
  for (const choice of agentChoices) {
    if (personEntities.length >= MAX_ENTITIES) break;
    pushPerson(choice.pubkey);
  }
  for (const [pubkey] of profiles) {
    if (personEntities.length >= MAX_ENTITIES) break;
    pushPerson(pubkey);
  }

  // 4. Agents.
  const seenAgents = new Set<string>();
  const agentEntities: VoiceEntity[] = [];
  for (const choice of agentChoices) {
    if (agentEntities.length >= MAX_ENTITIES) break;
    seenAgents.add(choice.pubkey);
    agentEntities.push({
      kind: "agent",
      id: choice.pubkey,
      label: choice.name,
      detail: "Agent",
      soundsLikeName: choice.name,
      meta: {
        pubkey: choice.pubkey,
        name: choice.name,
        available: canMessageAgent(choice),
      },
    });
  }
  for (const [pubkey, profile] of profiles) {
    if (agentEntities.length >= MAX_ENTITIES) break;
    if (!profile.isAgent || seenAgents.has(pubkey)) continue;
    seenAgents.add(pubkey);
    const name = resolveName(pubkey, profile.name);
    agentEntities.push({
      kind: "agent",
      id: pubkey,
      label: name,
      detail: "Agent",
      soundsLikeName: name,
      meta: { pubkey, name },
    });
  }

  // 5. Emojis.
  const emojiEntities: VoiceEntity[] = QUICK_EMOJIS.map((item) => ({
    kind: "emoji",
    id: item.id,
    label: item.label,
    soundsLikeName: item.label,
    meta: { emoji: item.id },
  }));

  return {
    channel: channelEntities,
    section: sectionEntities,
    person: personEntities,
    agent: agentEntities,
    emoji: emojiEntities,
  };
}
