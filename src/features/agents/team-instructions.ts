import type { AgentControl } from "./control";
import type { ChannelKit } from "../channel-templates/capability";
import type { Team } from "../channel-templates/model";
import type { TeamSnapshot } from "./team-bundles";
import type { RelaySession } from "../relay/session";
import type { Communities } from "../communities/service";
import { sameCommunityAgents } from "./choices";

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
  await kit.refresh({ after: true });
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

/** The community part of a relay session's scope, as native team calls take it. */
export const sessionCommunity = (scope: string, viewer: string) =>
  scope.slice(0, -(viewer.length + 1));

/** The text map native team calls take: unreadable teams are left out. */
export const readableTexts = (texts: readonly TeamText[]) =>
  Object.fromEntries(
    texts.flatMap(({ team, text }) =>
      text === undefined ? [] : [[team.id, text]],
    ),
  );

/** The agent and two teams that make a delivery impossible: one of the
 * owner's agents is listed on two teams with different text. Names them so
 * the user knows which team to edit. */
function deliveryConflict(
  texts: readonly TeamText[],
  control: AgentControl,
  scope: string,
): string | undefined {
  const agents = control.snapshot().data?.agents ?? [];
  for (const agent of sameCommunityAgents(agents, scope)) {
    const teams = texts.filter(
      ({ team, text }) => text && team.agents.includes(agent.pubkey),
    );
    const other = teams.find(({ text }) => text !== teams[0]?.text);
    if (teams[0] && other)
      return `${agent.name} is on teams "${teams[0].team.name}" and "${other.team.name}", which have different instructions. Give both teams the same instructions or remove the agent from one.`;
  }
  return undefined;
}

const deliveries = new WeakMap<ChannelKit, Promise<void>>();
const syncErrors = new WeakMap<ChannelKit, string>();
const syncListeners = new Set<() => void>();
function setSyncError(kit: ChannelKit, message: string | undefined) {
  if (syncErrors.get(kit) === message) return;
  if (message === undefined) syncErrors.delete(kit);
  else syncErrors.set(kit, message);
  for (const listener of syncListeners) listener();
}
/** Why app-start delivery gave up for this catalog, until a delivery
 * succeeds. */
export const teamSyncError = (kit: ChannelKit) => syncErrors.get(kit);
export function subscribeTeamSyncError(listener: () => void) {
  syncListeners.add(listener);
  return () => {
    syncListeners.delete(listener);
  };
}

/** Writes every team's current text into its members' settings and clears it
 * for agents no team with text lists. Never restarts: running members show
 * restart-needed instead. Runs after each team save or delete and once teams
 * load at app start. Deliveries for one catalog run one at a time, each from
 * its own fresh read, so an older pass can never land after a newer one. */
export function deliverTeamTexts(
  kit: ChannelKit,
  control: AgentControl | undefined,
  session: RelaySession | undefined,
): Promise<void> {
  return queueDelivery(kit, control, session).catch((reason) => {
    throw new Error(
      `Saved, but team members' instructions weren't updated: ${message(reason)}`,
    );
  });
}

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

function queueDelivery(
  kit: ChannelKit,
  control: AgentControl | undefined,
  session: RelaySession | undefined,
) {
  const run = (deliveries.get(kit) ?? Promise.resolve())
    .catch(() => {})
    .then(() => deliverNow(kit, control, session));
  deliveries.set(kit, run);
  return run;
}

async function deliverNow(
  kit: ChannelKit,
  control: AgentControl | undefined,
  session: RelaySession | undefined,
) {
  if (!control?.syncTeamInstructions || !session?.viewer) return;
  const texts = await readTeamTexts(kit, control);
  const conflict = deliveryConflict(texts, control, session.scope);
  if (conflict) throw new Error(conflict);
  await control.syncTeamInstructions(
    sessionCommunity(session.scope, session.viewer),
    readableTexts(texts),
  );
  setSyncError(kit, undefined);
}

/** App-start attempts before the failure is shown and retries stop. */
export const STARTUP_SYNC_ATTEMPTS = 4;

/** Delivers team text once per relay session, after its teams and the local
 * agents have both loaded and no other agent operation is running. It starts
 * the catalog read only once channel discovery is ready, the same gate the
 * channel views use, so the sync also runs when the app opens on a page
 * without a channel view. A failed delivery retries with backoff; after the
 * last attempt the error is shown until a later delivery succeeds. */
export function bindTeamTextSync(
  control: AgentControl,
  communities: Communities,
) {
  let watched: RelaySession | undefined;
  let synced: RelaySession | undefined;
  let running = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopSession = () => {};
  let stopped = false;
  const update = () => {
    const relay = communities.relay.snapshot();
    const session = relay.status === "ready" ? relay.session : undefined;
    if (session !== watched) {
      stopSession();
      clearTimeout(retry);
      retry = undefined;
      failures = 0;
      running = false;
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
    if (stopped || !session || synced === session || running || retry) return;
    if (session.channels.list().status === "ready") session.channelKit.ensure();
    const agents = control.snapshot();
    // A retry re-reads control and the catalog itself, since a failed
    // delivery or read leaves them unready; the first attempt waits for both.
    if (
      agents.busy ||
      (!failures &&
        (session.channelKit.snapshot().status !== "ready" ||
          agents.status !== "ready"))
    )
      return;
    running = true;
    const kit = session.channelKit;
    attempt(session).then(
      (delivered) => {
        if (stopped || watched !== session) return;
        running = false;
        if (delivered) synced = session;
        // An idle notice that arrived while this deferred attempt was still
        // running was dropped, so recheck admission now.
        else update();
      },
      (reason) => {
        if (stopped || watched !== session) return;
        running = false;
        failures += 1;
        console.warn("Team instruction sync failed", reason);
        if (failures >= STARTUP_SYNC_ATTEMPTS) {
          synced = session;
          setSyncError(
            kit,
            `Team members' instructions weren't updated: ${message(reason)}`,
          );
          return;
        }
        retry = setTimeout(
          () => {
            retry = undefined;
            update();
          },
          1_000 * 2 ** (failures - 1),
        );
      },
    );
  };
  /** Resolves false when control turned busy during its re-read, so the
   * attempt waits for idle without counting as a failure. */
  const attempt = async (session: RelaySession) => {
    if (failures) {
      await control.refresh();
      if (stopped || watched !== session) return false;
      const agents = control.snapshot();
      if (agents.busy) return false;
      if (agents.status !== "ready")
        throw new Error(agents.error ?? "Local agents can't be read right now");
    }
    await queueDelivery(session.channelKit, control, session);
    return true;
  };
  const stopRelay = communities.relay.subscribe(update);
  const stopControl = control.subscribe(update);
  update();
  return () => {
    stopped = true;
    clearTimeout(retry);
    stopSession();
    stopRelay();
    stopControl();
  };
}
