import { canMessageAgent, type AgentChoicesSnapshot } from "./choices";

/** The agent in the viewer's own one-to-one DM with an agent they may
 * message: a DM of exactly the viewer and one agent that is selectable (not
 * archived or deleting) and theirs to message. Returns that agent's pubkey.
 * Someone else's catalog agent, a person, or a larger DM returns undefined. */
export function ownAgentDm(
  channel:
    | Readonly<{
        channelType?: string | undefined;
        members?: readonly string[] | undefined;
        archived?: boolean | undefined;
      }>
    | undefined,
  viewer: string | undefined,
  choices: Pick<AgentChoicesSnapshot, "selectable">,
): string | undefined {
  const members = channel?.members;
  if (
    channel?.channelType !== "dm" ||
    channel.archived ||
    !viewer ||
    members?.length !== 2 ||
    !members.includes(viewer)
  )
    return undefined;
  const other = members.find((key) => key !== viewer);
  const agent = choices.selectable.find((row) => row.pubkey === other);
  return agent && canMessageAgent(agent) ? agent.pubkey : undefined;
}
