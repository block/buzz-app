/** The same local-agent choices apply to picker, completion and selected draft chips. */
export function availableMentionAgents(
  channel: import("../relay/contracts").ChannelSummary | undefined,
  agents: readonly { pubkey: string; name: string; managed?: boolean }[],
  inviteAgents: boolean | undefined,
  canInvite: boolean | undefined,
) {
  return !inviteAgents &&
    channel?.members &&
    !channel.archived &&
    (channel.channelType === "stream" || channel.channelType === "forum") &&
    canInvite
    ? agents.filter((agent) => agent.managed && !channel.members?.includes(agent.pubkey))
    : [];
}
