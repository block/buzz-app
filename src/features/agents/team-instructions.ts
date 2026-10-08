import type { AgentControl } from "./control";
import type { ChannelKit } from "../channel-templates/capability";
import type { Team } from "../channel-templates/model";

export type TeamText = { team: Team; text: string };

/** Current text of every live team. A portable team whose definition can't be
 * read is left out, so it counts as temporarily missing, never as removed. */
export async function readTeamTexts(
  kit: ChannelKit,
  control: AgentControl,
): Promise<TeamText[]> {
  const texts: TeamText[] = [];
  for (const { record } of kit.snapshot().entries) {
    if (record.deleted || record.value.type !== "team") continue;
    const team = record.value;
    if (!team.portable) {
      texts.push({ team, text: "" });
      continue;
    }
    try {
      const snapshot = await control.previewTeam?.(
        JSON.stringify(await kit.loadTeam(team)),
      );
      if (snapshot)
        texts.push({ team, text: snapshot.team.instructions?.trim() ?? "" });
    } catch {
      // Unreadable now; the next sync retries it.
    }
  }
  return texts;
}

/** Refuses a save that would give one agent two different team texts.
 * Teams without text never conflict. */
export function teamTextConflict(
  others: readonly TeamText[],
  team: Pick<Team, "id" | "agents">,
  text: string,
): string | undefined {
  if (!text.trim()) return undefined;
  const other = others.find(
    (other) =>
      other.team.id !== team.id &&
      other.text &&
      other.text !== text.trim() &&
      other.team.agents.some((agent) => team.agents.includes(agent)),
  );
  return other
    ? `An agent on this team is also on "${other.team.name}", which has different team instructions. Remove the agent from one team or use the same instructions.`
    : undefined;
}
