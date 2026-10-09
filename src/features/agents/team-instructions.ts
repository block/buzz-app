import type { AgentControl } from "./control";
import type { ChannelKit } from "../channel-templates/capability";
import type { Team } from "../channel-templates/model";
import type { TeamSnapshot } from "./team-bundles";
import type { RelaySession } from "../relay/session";
import type { Communities } from "../communities/service";

/** `text` is trimmed for delivery; `undefined` means it can't be read now. */
export type TeamText = { team: Team; text: string | undefined };
type TextReader = Pick<ChannelKit, "readText" | "loadTeam">;

async function portableMeta(
  kit: TextReader,
  control: AgentControl | undefined,
  team: Team,
): Promise<TeamSnapshot["team"] | undefined> {
  if (!team.portable) return undefined;
  if (!control?.previewTeam) throw new Error("Team preview is unavailable");
  return (await control.previewTeam(JSON.stringify(await kit.loadTeam(team))))
    .team;
}

/** The one reader of a live team's current instructions, as saved (untrimmed).
 * A team-text head wins, even when empty or a tombstone. Only a fresh read
 * that proves there is no head falls back to a portable bundle's text. */
export async function resolveTeamText(
  kit: TextReader,
  control: AgentControl | undefined,
  team: Team,
  legacy = () => portableMeta(kit, control, team),
): Promise<{ text: string; head: string | undefined }> {
  const current = await kit.readText(team.id);
  if (current) return current;
  return { text: (await legacy())?.instructions ?? "", head: undefined };
}

/** The team metadata exports and shares carry: current name and text, plus a
 * portable team's retained description. */
export async function teamExportMeta(
  kit: TextReader,
  control: AgentControl | undefined,
  team: Team,
): Promise<TeamSnapshot["team"]> {
  let meta: ReturnType<typeof portableMeta> | undefined;
  const portable = () => (meta ??= portableMeta(kit, control, team));
  const { text } = await resolveTeamText(kit, control, team, portable);
  const description = (await portable())?.description;
  return {
    name: team.name,
    ...(description ? { description } : {}),
    instructions: text,
  };
}

/** Current text of every saved team, from a fresh catalog read so rosters
 * are never stale. A deleted team has no members and no text, so the sync
 * releases it without loading any payload. */
export async function readTeamTexts(
  kit: ChannelKit,
  control: AgentControl | undefined,
): Promise<TeamText[]> {
  await kit.refresh();
  if (kit.snapshot().status !== "ready")
    throw new Error("Teams can't be read right now");
  const texts: TeamText[] = [];
  for (const { record } of kit.snapshot().entries) {
    if (record.value.type !== "team") continue;
    const team = record.value;
    if (record.deleted) {
      texts.push({ team: { ...team, agents: [] }, text: "" });
      continue;
    }
    try {
      texts.push({
        team,
        text: (await resolveTeamText(kit, control, team)).text.trim(),
      });
    } catch {
      texts.push({ team, text: undefined });
    }
  }
  return texts;
}

/** Refuses a save that would give one agent two different team texts.
 * Teams without text never conflict; an unreadable overlapping team means
 * the check can't complete. */
export function teamTextConflict(
  others: readonly TeamText[],
  team: Pick<Team, "id" | "agents">,
  text: string,
): string | undefined {
  if (!text.trim()) return undefined;
  const overlapping = others.filter(
    (other) =>
      other.team.id !== team.id &&
      other.text !== "" &&
      other.team.agents.some((agent) => team.agents.includes(agent)),
  );
  const unreadable = overlapping.find((other) => other.text === undefined);
  if (unreadable)
    return `An agent on this team is also on "${unreadable.team.name}", whose instructions can't be read right now, so the save can't be checked. Try again.`;
  const other = overlapping.find((other) => other.text !== text.trim());
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
      Object.fromEntries(
        texts.flatMap(({ team, text }) =>
          text === undefined ? [] : [[team.id, text]],
        ),
      ),
    );
  } catch (reason) {
    throw new Error(
      `Saved, but team members' instructions weren't updated: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  }
}

/** Delivers team text once per relay session, after its teams and the local
 * agents have both loaded. It starts the catalog read only once channel
 * discovery is ready, the same gate the channel views use, so the sync also
 * runs when the app opens on a page without a channel view. */
export function bindTeamTextSync(
  control: AgentControl,
  communities: Communities,
) {
  let watched: RelaySession | undefined;
  let synced: RelaySession | undefined;
  let stopSession = () => {};
  const update = () => {
    const relay = communities.relay.snapshot();
    const session = relay.status === "ready" ? relay.session : undefined;
    if (session !== watched) {
      stopSession();
      watched = session;
      if (session) {
        const stopKit = session.channelKit.subscribe(update);
        const stopList = session.channels.subscribeList(update);
        stopSession = () => {
          stopKit();
          stopList();
        };
      } else stopSession = () => {};
    }
    if (!session || synced === session) return;
    if (session.channels.list().status === "ready") session.channelKit.ensure();
    if (
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
    stopSession();
    stopRelay();
    stopControl();
  };
}
