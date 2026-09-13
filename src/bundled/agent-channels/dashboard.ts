import type {
  AgentChannelEdge,
  AgentChannelGraph,
  AgentNode,
  ChannelNode,
} from "./relationships";

export type AgentChannelRelationship = Readonly<{
  channel: ChannelNode;
  edge: AgentChannelEdge;
}>;

export type AgentDashboardRow = Readonly<{
  agent: AgentNode;
  relationships: readonly AgentChannelRelationship[];
  currentChannelCount: number;
  pastChannelCount: number;
  unknownChannelCount: number;
  observedMessageCount: number;
  firstObservedAt?: number;
  lastObservedAt?: number;
}>;

export type AgentFocusNetwork = Readonly<{
  selected: AgentDashboardRow;
  channels: readonly AgentChannelRelationship[];
  collaborators: readonly Readonly<{
    row: AgentDashboardRow;
    channelIds: readonly string[];
  }>[];
  channelsLimited: boolean;
  collaboratorsLimited: boolean;
}>;

export const FOCUS_CHANNEL_LIMIT = 6;
export const FOCUS_COLLABORATOR_LIMIT = 8;

export function buildAgentDashboard(
  graph: AgentChannelGraph,
): readonly AgentDashboardRow[] {
  const channels = new Map(
    graph.channels.map((channel) => [channel.id, channel]),
  );
  const edges = new Map<string, AgentChannelEdge[]>();
  for (const edge of graph.edges) {
    const grouped = edges.get(edge.agentId);
    if (grouped) grouped.push(edge);
    else edges.set(edge.agentId, [edge]);
  }

  return Object.freeze(
    graph.agents
      .map((agent) => {
        const relationships = (edges.get(agent.id) ?? [])
          .flatMap((edge) => {
            const channel = channels.get(edge.channelId);
            return channel ? [{ channel, edge }] : [];
          })
          .sort(compareRelationships);
        const observed = relationships.filter(
          ({ edge }) => edge.lastObservedAt !== undefined,
        );
        const firstObservedAt = observed.length
          ? Math.min(...observed.map(({ edge }) => edge.firstObservedAt ?? 0))
          : undefined;
        const lastObservedAt = observed.length
          ? Math.max(...observed.map(({ edge }) => edge.lastObservedAt ?? 0))
          : undefined;
        return Object.freeze({
          agent,
          relationships: Object.freeze(relationships),
          currentChannelCount: relationships.filter(
            ({ edge }) => edge.membership === "current",
          ).length,
          pastChannelCount: relationships.filter(
            ({ edge }) => edge.membership === "past",
          ).length,
          unknownChannelCount: relationships.filter(
            ({ edge }) => edge.membership === "unknown",
          ).length,
          observedMessageCount: relationships.reduce(
            (total, { edge }) => total + edge.observedMessageCount,
            0,
          ),
          ...(firstObservedAt !== undefined ? { firstObservedAt } : {}),
          ...(lastObservedAt !== undefined ? { lastObservedAt } : {}),
        });
      })
      .sort(
        (a, b) =>
          b.currentChannelCount - a.currentChannelCount ||
          (b.lastObservedAt ?? 0) - (a.lastObservedAt ?? 0) ||
          b.observedMessageCount - a.observedMessageCount ||
          a.agent.name.localeCompare(b.agent.name, "en"),
      ),
  );
}

export function buildAgentFocusNetwork(
  dashboard: readonly AgentDashboardRow[],
  agentId: string,
  channelLimit = FOCUS_CHANNEL_LIMIT,
  collaboratorLimit = FOCUS_COLLABORATOR_LIMIT,
): AgentFocusNetwork | undefined {
  const selected = dashboard.find((row) => row.agent.id === agentId);
  if (!selected) return undefined;
  const channels = selected.relationships.slice(0, channelLimit);
  const channelIds = new Set(channels.map(({ channel }) => channel.id));
  const collaborators = dashboard
    .filter((row) => row.agent.id !== agentId)
    .flatMap((row) => {
      const shared = row.relationships
        .filter(({ channel }) => channelIds.has(channel.id))
        .map(({ channel }) => channel.id);
      return shared.length ? [{ row, channelIds: Object.freeze(shared) }] : [];
    })
    .sort(
      (a, b) =>
        b.channelIds.length - a.channelIds.length ||
        (b.row.lastObservedAt ?? 0) - (a.row.lastObservedAt ?? 0) ||
        a.row.agent.name.localeCompare(b.row.agent.name, "en"),
    );
  return Object.freeze({
    selected,
    channels: Object.freeze(channels),
    collaborators: Object.freeze(collaborators.slice(0, collaboratorLimit)),
    channelsLimited: selected.relationships.length > channels.length,
    collaboratorsLimited: collaborators.length > collaboratorLimit,
  });
}

function compareRelationships(
  a: AgentChannelRelationship,
  b: AgentChannelRelationship,
) {
  return (
    membershipRank(a.edge.membership) - membershipRank(b.edge.membership) ||
    (b.edge.lastObservedAt ?? 0) - (a.edge.lastObservedAt ?? 0) ||
    b.edge.observedMessageCount - a.edge.observedMessageCount ||
    a.channel.name.localeCompare(b.channel.name, "en")
  );
}

function membershipRank(membership: AgentChannelEdge["membership"]) {
  if (membership === "current") return 0;
  if (membership === "unknown") return 1;
  return 2;
}
