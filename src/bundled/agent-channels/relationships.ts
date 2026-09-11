import type { AgentLibrary } from "../../features/agents/library";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { VisibleEvent } from "../../features/relay/projection";
import type { RelaySession } from "../../features/relay/session";

export type AgentNode = Readonly<{
  id: string;
  name: string;
  avatar?: string;
  identityPubkeys: readonly string[];
}>;
export type ChannelNode = Readonly<{
  id: string;
  name: string;
  kind?: ChannelSummary["channelType"];
  archived: boolean;
}>;
export type AgentChannelEdge = Readonly<{
  agentId: string;
  channelId: string;
  membership: "current" | "past" | "unknown";
  firstObservedAt?: number;
  lastObservedAt?: number;
  observedMessageCount: number;
}>;
export type AgentChannelGraph = Readonly<{
  agents: readonly AgentNode[];
  channels: readonly ChannelNode[];
  edges: readonly AgentChannelEdge[];
  edgesLimited: boolean;
}>;

const HISTORY_PAGE_SIZE = 500;
export const HISTORY_EVENT_LIMIT = 2_000;
export const GRAPH_EDGE_LIMIT = 10_000;
const AUTHOR_BATCH_SIZE = 300;
const CHANNEL_BATCH_SIZE = 300;

export function agentNodes(
  library: AgentLibrary,
  archived: (pubkey: string) => boolean,
): readonly AgentNode[] {
  const visible = library.identities.filter(
    (identity) => !archived(identity.pubkey),
  );
  const definitions = new Map(
    library.definitions.map((definition) => [definition.id, definition]),
  );
  const grouped = library.definitions.map((definition) => ({
    id: `definition:${definition.id}`,
    name: definition.name,
    ...(definition.avatar ? { avatar: definition.avatar } : {}),
    identityPubkeys: visible
      .filter((identity) => identity.definitionId === definition.id)
      .map((identity) => identity.pubkey),
  }));
  const loose = visible
    .filter(
      (identity) =>
        !identity.definitionId || !definitions.has(identity.definitionId),
    )
    .map((identity) => ({
      id: `identity:${identity.pubkey}`,
      name: identity.name,
      ...(identity.avatar ? { avatar: identity.avatar } : {}),
      identityPubkeys: [identity.pubkey],
    }));
  return Object.freeze(
    [...grouped, ...loose]
      .filter((agent) => agent.identityPubkeys.length > 0)
      .map((agent) => Object.freeze(agent)),
  );
}

export function isObservedActivityEvent(event: VisibleEvent): boolean {
  return (
    event.delivery === undefined ||
    event.delivery === "accepted" ||
    event.delivery === "seen"
  );
}

export function buildAgentChannelGraph(
  channels: readonly ChannelSummary[],
  agents: readonly AgentNode[],
  activity: readonly VisibleEvent[],
  membershipComplete = true,
): AgentChannelGraph {
  const channelNodes = channels.map((channel) =>
    Object.freeze({
      id: channel.id,
      name: channel.name,
      kind: channel.channelType,
      archived: !!channel.archived,
    }),
  );
  const channelsById = new Map(
    channels.map((channel) => [channel.id, channel]),
  );
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const agentByIdentity = new Map(
    agents.flatMap((agent) =>
      agent.identityPubkeys.map((pubkey) => [pubkey, agent] as const),
    ),
  );
  const observed = new Map<
    string,
    {
      agentId: string;
      channelId: string;
      first: number;
      last: number;
      count: number;
    }
  >();
  for (const event of activity) {
    if (event.kind !== 9 || !isObservedActivityEvent(event)) continue;
    const agent = agentByIdentity.get(event.pubkey);
    const channelId = event.tags.find(([name]) => name === "h")?.[1];
    if (!agent || !channelId || !channelsById.has(channelId)) continue;
    const key = `${agent.id}\u0000${channelId}`;
    const edge = observed.get(key);
    if (edge) {
      edge.first = Math.min(edge.first, event.created_at);
      edge.last = Math.max(edge.last, event.created_at);
      edge.count++;
    } else {
      observed.set(key, {
        agentId: agent.id,
        channelId,
        first: event.created_at,
        last: event.created_at,
        count: 1,
      });
    }
  }
  const memberChannelsByIdentity = new Map<string, string[]>();
  for (const channel of channels)
    for (const pubkey of channel.members ?? []) {
      const memberChannels = memberChannelsByIdentity.get(pubkey);
      if (memberChannels) memberChannels.push(channel.id);
      else memberChannelsByIdentity.set(pubkey, [channel.id]);
    }
  const edgeKeys = new Set(observed.keys());
  const currentKeys = new Set<string>();
  for (const agent of agents)
    for (const pubkey of agent.identityPubkeys)
      for (const channelId of memberChannelsByIdentity.get(pubkey) ?? []) {
        const key = `${agent.id}\u0000${channelId}`;
        edgeKeys.add(key);
        currentKeys.add(key);
      }
  const sortedEdgeKeys = [...edgeKeys].sort((a, b) => {
    const aObserved = observed.get(a);
    const bObserved = observed.get(b);
    return (
      Number(currentKeys.has(b)) - Number(currentKeys.has(a)) ||
      (bObserved?.last ?? 0) - (aObserved?.last ?? 0) ||
      a.localeCompare(b)
    );
  });
  const edges: AgentChannelEdge[] = [];
  for (const key of sortedEdgeKeys) {
    if (edges.length >= GRAPH_EDGE_LIMIT) break;
    const separator = key.indexOf("\u0000");
    const agentId = key.slice(0, separator);
    const channelId = key.slice(separator + 1);
    const agent = agentsById.get(agentId);
    const channel = channelsById.get(channelId);
    if (!agent || !channel) continue;
    const activityEdge = observed.get(key);
    const membership = currentKeys.has(key)
      ? membershipComplete
        ? "current"
        : "unknown"
      : channel.members && membershipComplete
        ? "past"
        : "unknown";
    edges.push(
      Object.freeze({
        agentId,
        channelId,
        membership,
        ...(activityEdge
          ? {
              firstObservedAt: activityEdge.first,
              lastObservedAt: activityEdge.last,
            }
          : {}),
        observedMessageCount: activityEdge?.count ?? 0,
      }),
    );
  }
  return Object.freeze({
    agents,
    channels: Object.freeze(channelNodes),
    edges: Object.freeze(edges),
    edgesLimited: sortedEdgeKeys.length > edges.length,
  });
}

/** Reads a bounded recent activity sample through the shared verified session.
 * The response has no completeness bound, so callers must describe it as observed activity. */
export async function readAgentActivity(
  session: RelaySession,
  pubkeys: readonly string[],
  channelIds: readonly string[],
  signal: AbortSignal,
): Promise<readonly VisibleEvent[]> {
  const authorBatches = batches([...new Set(pubkeys)], AUTHOR_BATCH_SIZE);
  const channelBatches = batches([...new Set(channelIds)], CHANNEL_BATCH_SIZE);
  const queries = authorBatches.flatMap((authors) =>
    channelBatches.map((channels) => ({ authors, channels })),
  );
  const events = new Map<string, VisibleEvent>();
  let remainingBudget = HISTORY_EVENT_LIMIT;
  for (const [index, query] of queries.entries()) {
    const batchBudget = Math.floor(remainingBudget / (queries.length - index));
    for (const event of await readActivityBatch(
      session,
      query.authors,
      query.channels,
      signal,
      batchBudget,
    ))
      events.set(event.id, event);
    remainingBudget -= batchBudget;
  }
  return Object.freeze(
    [...events.values()]
      .filter(isObservedActivityEvent)
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .slice(0, HISTORY_EVENT_LIMIT),
  );
}

async function readActivityBatch(
  session: RelaySession,
  authors: readonly string[],
  channelIds: readonly string[],
  signal: AbortSignal,
  eventBudget: number,
): Promise<readonly VisibleEvent[]> {
  const events = new Map<string, VisibleEvent>();
  const relayEvents = new Map<string, VisibleEvent>();
  let cursor: { createdAt: number; eventId: string } | undefined;
  while (relayEvents.size < eventBudget) {
    signal.throwIfAborted();
    const requestLimit = Math.min(
      HISTORY_PAGE_SIZE,
      eventBudget - relayEvents.size,
    );
    const page = await session.read(
      [
        {
          kinds: [9],
          authors,
          "#h": channelIds,
          limit: requestLimit,
          ...(cursor
            ? { until: cursor.createdAt, before_id: cursor.eventId }
            : {}),
        },
      ],
      { signal, priority: "background" },
    );
    for (const event of page) events.set(event.id, event);
    const relayPage = page.filter(
      (event) =>
        isObservedActivityEvent(event) && event.delivery !== "accepted",
    );
    for (const event of relayPage) relayEvents.set(event.id, event);
    if (page.length < requestLimit || relayEvents.size >= eventBudget) break;
    const oldest = [...relayPage].sort(
      (a, b) => a.created_at - b.created_at || b.id.localeCompare(a.id),
    )[0];
    if (!oldest) break;
    const next = { createdAt: oldest.created_at, eventId: oldest.id };
    if (
      cursor &&
      (next.createdAt > cursor.createdAt ||
        (next.createdAt === cursor.createdAt && next.eventId <= cursor.eventId))
    )
      break;
    cursor = next;
  }
  return Object.freeze([...events.values()].filter(isObservedActivityEvent));
}

function batches<T>(values: readonly T[], size: number): readonly T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );
}
