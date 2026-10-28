import type { ChannelSummary } from "../../features/relay/contracts";
import type { ComposerSession } from "../../features/messages/composer-session";
import type { MentionRecipient } from "../../features/messages/mention-draft";
import { knownAgentPubkeys } from "../../features/agents/known";
import type { Agent } from "../../features/agents/service";
import { communityHost } from "../../features/messages/community-host";
import {
  allowsOutsideMentions,
  archivedMention,
  mentionAdmission,
} from "../../features/messages/mention-admission";

/** The viewer's agents offered outside a stream or forum when the viewer can add members. */
function availableMentionAgents<T extends { pubkey: string }>(
  channel: ChannelSummary | undefined,
  agents: readonly T[],
  canInvite: boolean | undefined,
) {
  if (
    !channel?.members ||
    (channel.channelType !== "stream" && channel.channelType !== "forum") ||
    !canInvite
  )
    return [];
  const members = new Set(channel.members);
  return agents.filter((agent) => !members.has(agent.pubkey));
}

/** Row detail for an outside choice. Nobody can be added to a DM. */
export function outsideMentionDetail(
  channel: Pick<ChannelSummary, "channelType"> | undefined,
  elsewhere?: string,
) {
  if (elsewhere) return `In ${elsewhere}`;
  return channel?.channelType === "dm"
    ? "Not in DM · Will not be notified"
    : "Not in channel · Choose whether to add when you send";
}

type DirectoryPerson = MentionRecipient & { isAgent?: true };
type ElsewhereAgent = Pick<Agent, "pubkey" | "name" | "relay">;
const none: readonly never[] = [];
// Rows change only with their sources, not with each keystroke. Snapshots are
// immutable, so identity is their revision; `joinable()` copies on each call.
const built = new WeakMap<
  ComposerSession,
  Map<string, { sources: readonly unknown[]; rows: MentionCandidate[] }>
>();
export type MentionCandidate = ReturnType<typeof buildCandidates>[number];

/** What the chooser offers. The host admits recipients itself (mention-admission). No reads or writes. */
export function mentionCandidates(
  session: ComposerSession,
  channelId: string,
  inviteAgents = false,
  roster?: readonly MentionRecipient[],
  directory: readonly DirectoryPerson[] = none,
  /** The owner's agents in their other communities (`agents.joinable()`). */
  elsewhere: readonly ElsewhereAgent[] = none,
): readonly MentionCandidate[] {
  const sources = [
    // Only this channel's row; activity elsewhere replaces the list, not it.
    session.channels.list().channels.find((c) => c.id === channelId),
    session.agentChoices.snapshot(),
    session.profiles.snapshot(),
    session.archives?.snapshot(),
    session.outbox?.supports(9000),
    roster,
    directory,
    JSON.stringify(
      elsewhere.map(({ pubkey, name, relay }) => [pubkey, name, relay]),
    ),
  ];
  // The chooser reads both its directory rows and its local rows each render.
  const key = JSON.stringify([channelId, inviteAgents, directory === none]);
  const cache: Map<
    string,
    { sources: readonly unknown[]; rows: MentionCandidate[] }
  > = built.get(session) ?? new Map();
  built.set(session, cache);
  const hit = cache.get(key);
  if (hit?.sources.every((source, i) => source === sources[i])) return hit.rows;
  const rows = buildCandidates(
    session,
    channelId,
    inviteAgents,
    roster,
    directory,
    elsewhere,
  );
  cache.set(key, { sources, rows });
  return rows;
}

function buildCandidates(
  session: ComposerSession,
  channelId: string,
  inviteAgents: boolean,
  roster: readonly MentionRecipient[] | undefined,
  directory: readonly DirectoryPerson[],
  elsewhere: readonly ElsewhereAgent[],
) {
  const channel = session.channels
    .list()
    .channels.find((c) => c.id === channelId);
  const members = roster?.map((p) => p.pubkey) ?? channel?.members ?? [];
  const memberKeys = new Set(members);
  const agents = session.agentChoices.snapshot().identities;
  const profiles = session.profiles.snapshot();
  const known = knownAgentPubkeys(profiles, {
    definitions: [],
    identities: agents,
  });
  const choices = new Map<string, MentionRecipient>();
  for (const person of roster ??
    (inviteAgents && channel?.channelType !== "dm"
      ? agents
      : availableMentionAgents(
          channel,
          agents,
          session.outbox?.supports(9000),
        )))
    choices.set(person.pubkey, { pubkey: person.pubkey, name: person.name });
  if (!roster && !inviteAgents && allowsOutsideMentions(channel))
    for (const person of directory) choices.set(person.pubkey, person);
  // Another community's agent is never a member or an agent here; it only
  // takes a row no one in this community has. Sending asks before it joins.
  const hosts = new Map<string, string>();
  if (!roster && !inviteAgents)
    for (const agent of availableMentionAgents(
      channel,
      elsewhere,
      session.outbox?.supports(9000),
    )) {
      const host = communityHost(agent.relay);
      // Its row here, archived when it was removed, is the one it takes.
      if (
        !host ||
        memberKeys.has(agent.pubkey) ||
        (choices.has(agent.pubkey) && !archivedMention(session, agent.pubkey))
      )
        continue;
      choices.set(agent.pubkey, { pubkey: agent.pubkey, name: agent.name });
      hosts.set(agent.pubkey, host);
    }
  for (const pubkey of members)
    choices.set(pubkey, {
      pubkey,
      name:
        profiles.get(pubkey)?.name ||
        choices.get(pubkey)?.name ||
        pubkey.slice(0, 12),
    });
  // Offer only what the composer will accept.
  const admits = mentionAdmission(
    session,
    channelId,
    inviteAgents,
    roster,
    new Set(hosts.keys()),
  );
  // Keyed lookups keep one pass over members linear in a large channel.
  const listed = new Map<string, string>();
  const directoryAgents = new Set<string>();
  for (const person of directory) {
    if (!listed.has(person.pubkey)) listed.set(person.pubkey, person.name);
    if (person.isAgent) directoryAgents.add(person.pubkey);
  }
  const rostered = new Map<string, string>();
  for (const person of roster ?? [])
    if (!rostered.has(person.pubkey)) rostered.set(person.pubkey, person.name);
  const agentNames = new Map<string, string[]>();
  const managed = new Set<string>();
  for (const agent of agents) {
    agentNames.set(agent.pubkey, [
      ...(agentNames.get(agent.pubkey) ?? []),
      agent.name,
    ]);
    if (agent.managed) managed.add(agent.pubkey);
  }
  return [...choices.values()]
    .filter((p) => admits(p.pubkey))
    .map((recipient) => ({
      recipient,
      member: memberKeys.has(recipient.pubkey),
      /** The host of the owner's other community this agent is in. */
      ...(hosts.has(recipient.pubkey)
        ? { elsewhere: hosts.get(recipient.pubkey) }
        : {}),
      agent:
        hosts.has(recipient.pubkey) ||
        known.has(recipient.pubkey) ||
        directoryAgents.has(recipient.pubkey),
      owned:
        !!session.viewer &&
        profiles.get(recipient.pubkey)?.ownerPubkey === session.viewer,
      managed: managed.has(recipient.pubkey),
      aliases: [
        ...new Set(
          [
            profiles.get(recipient.pubkey)?.name ||
              listed.get(recipient.pubkey) ||
              rostered.get(recipient.pubkey),
            ...(agentNames.get(recipient.pubkey) ?? []),
            hosts.has(recipient.pubkey) ? recipient.name : undefined,
          ].filter((name): name is string => !!name),
        ),
      ],
    }));
}
