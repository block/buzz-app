import { sameCommunityAgents } from "./choices";
import type { AgentControl } from "./control";
import type { Team } from "../channel-templates/model";
import type { RelaySession } from "../relay/session";
import {
  addChannelMember,
  startAddedAgent,
  type MemberAdditionIntent,
} from "../channel-members/members";
export interface TeamDeployment {
  team: Team;
  channelId: string;
  additions: MemberAdditionIntent[];
}
export function teamDeployment(team: Team, channelId: string): TeamDeployment {
  return {
    team: structuredClone(team),
    channelId,
    additions: team.agents.map(() => ({})),
  };
}
/** Deploy only adds the saved members to a channel and starts stopped ones.
 * Team text is delivered by team Save, never here. */
export async function deployTeam(
  control: AgentControl | undefined,
  session: RelaySession,
  attempt: TeamDeployment,
  signal: AbortSignal,
) {
  const failures: string[] = [];
  for (const [index, pubkey] of attempt.team.agents.entries()) {
    signal.throwIfAborted();
    try {
      await control?.refresh();
      signal.throwIfAborted();
      const agent = sameCommunityAgents(
        control?.snapshot().data?.agents ?? [],
        session.scope,
      ).find((agent) => agent.pubkey === pubkey);
      signal.throwIfAborted();
      if (agent?.profilePending) {
        if (!control?.publishProfile)
          throw new Error("Profile publication is unavailable");
        await control.publishProfile(agent.id);
      }
      await addChannelMember(
        session,
        attempt.channelId,
        pubkey,
        signal,
        attempt.additions[index],
      );
      await startAddedAgent(
        control,
        session,
        attempt.channelId,
        pubkey,
        signal,
        true,
      );
    } catch (error) {
      failures.push(
        `${pubkey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}
