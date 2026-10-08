import type { AgentControl } from "./control";
import type { ChannelKit } from "../channel-templates/capability";
import type { Team } from "../channel-templates/model";
import type { RelaySession } from "../relay/session";
import type { Communities } from "../communities/service";

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

/** Writes every team's current text into its members' settings and clears it
 * for agents no team with text lists. Never restarts: running members show
 * restart-needed instead. Runs after each team save or delete and once teams
 * load at app start. */
export async function deliverTeamTexts(
  kit: ChannelKit,
  control: AgentControl | undefined,
  session: RelaySession | undefined,
) {
  if (!control?.syncTeamInstructions || !session?.viewer) return;
  try {
    const texts = await readTeamTexts(kit, control);
    await control.syncTeamInstructions(
      session.scope.slice(0, -(session.viewer.length + 1)),
      Object.fromEntries(texts.map(({ team, text }) => [team.id, text])),
    );
  } catch (reason) {
    throw new Error(
      `Saved, but team members' instructions weren't updated: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  }
}

/** Delivers team text once per relay session, after its teams and the local
 * agents have both loaded. */
export function bindTeamTextSync(
  control: AgentControl,
  communities: Communities,
) {
  let watched: RelaySession | undefined;
  let synced: RelaySession | undefined;
  let stopKit = () => {};
  const update = () => {
    const relay = communities.relay.snapshot();
    const session = relay.status === "ready" ? relay.session : undefined;
    if (session !== watched) {
      stopKit();
      watched = session;
      stopKit = session?.channelKit.subscribe(update) ?? (() => {});
      session?.channelKit.ensure();
    }
    if (
      !session ||
      synced === session ||
      session.channelKit.snapshot().status !== "ready" ||
      control.snapshot().status !== "ready"
    )
      return;
    synced = session;
    void deliverTeamTexts(session.channelKit, control, session).catch(
      (reason) => console.warn("Team instruction sync failed", reason),
    );
  };
  const stopRelay = communities.relay.subscribe(update);
  const stopControl = control.subscribe(update);
  update();
  return () => {
    stopKit();
    stopRelay();
    stopControl();
  };
}
