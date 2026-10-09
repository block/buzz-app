import type { ChannelKit } from "../channel-templates/capability";
import type { Team } from "../channel-templates/model";
import type { AgentControl, PendingBetaTeam } from "./control";
import {
  readableTexts,
  readTeamTexts,
  resolveTeamText,
  teamTextConflict,
} from "./team-instructions";

export type BetaTeamOutcome = { finished: string[]; failed: string[] };

const liveTeam = (kit: ChannelKit, teamId: string) => {
  const entry = kit
    .snapshot()
    .entries.find(
      (e) => e.record.value.type === "team" && e.record.value.id === teamId,
    );
  return entry && { entry, team: entry.record.value as Team };
};

/** What the step would write against the current catalog: the roster with
 * every pending member, and the old Buzz text only when the team has never
 * had instructions saved (no text head and no text in a portable file). */
async function plan(
  kit: ChannelKit,
  control: AgentControl,
  team: PendingBetaTeam,
  text: string,
) {
  const current = liveTeam(kit, team.teamId);
  if (current?.entry.record.deleted) return { deleted: true as const };
  const saved = current
    ? await resolveTeamText(kit, control, current.team)
    : { text: "", head: undefined };
  const publish =
    saved.head === undefined && !saved.text.trim() && !!text.trim();
  const agents = [
    ...new Set([
      ...(current?.team.agents ?? []),
      ...team.members.map((m) => m.pubkey),
    ]),
  ];
  const roster: Team = current
    ? { ...current.team, agents }
    : { type: "team", id: team.teamId, name: team.name, agents };
  return {
    deleted: false as const,
    head: current?.entry.eventId,
    roster,
    rosterChanged: agents.length !== current?.team.agents.length,
    publish,
    text: publish ? text : saved.text,
  };
}

/** Plans against a fresh catalog and validates that exact plan, so the
 * caller writes only what was checked. */
async function checkedPlan(
  kit: ChannelKit,
  control: AgentControl,
  team: PendingBetaTeam,
  text: string,
) {
  const others = await readTeamTexts(kit, control);
  const next = await plan(kit, control, team, text);
  const conflict = next.deleted
    ? undefined
    : teamTextConflict(others, next.roster, next.text);
  return { next, conflict };
}

/** A save the step would refuse because a member would get two different
 * team texts. Reads a fresh catalog. */
export async function betaTeamConflict(
  kit: ChannelKit,
  control: AgentControl,
  team: PendingBetaTeam,
  text: string,
) {
  return (await checkedPlan(kit, control, team, text)).conflict;
}

/** Brings one team from old Buzz into the current catalog and finishes its
 * pending agents. Keeps no record of its own: every run reads the catalog as
 * it is now and fills in what is missing, so a rerun after any failure is
 * harmless. A deleted team stays deleted and its agents are skipped. The
 * native finish re-reads the roster, so a member removed meanwhile stays
 * pending. */
export async function runBetaTeamStep(
  kit: ChannelKit,
  control: AgentControl,
  community: string,
  team: PendingBetaTeam,
  choice: { text: string },
): Promise<BetaTeamOutcome> {
  const finish = control.finishBetaTeam;
  if (!finish) throw new Error("Teams from old Buzz are unavailable.");
  const check = async () => {
    const { next, conflict } = await checkedPlan(
      kit,
      control,
      team,
      choice.text,
    );
    if (conflict) throw new Error(conflict);
    return next;
  };
  const next = await check();
  if (!next.deleted) {
    let head = next.head;
    // The save guards only this team's record: the relay cannot make it
    // depend on another record, so a text-only edit to an overlapping team
    // after the check goes undetected. Native finish and the delivery check
    // both refuse then, so the agent stays pending and never runs with mixed
    // instructions; the clashing roster stays until either team is edited.
    if (next.rosterChanged) head = await kit.save(next.roster, next.head);
    if (next.publish) {
      const manifest = await kit.prepareText(
        team.teamId,
        choice.text,
        crypto.randomUUID(),
      );
      await check();
      await kit.publishText(team.teamId, manifest, undefined, head);
    }
  }
  const texts = readableTexts(await readTeamTexts(kit, control));
  const outcome: BetaTeamOutcome = { finished: [], failed: [] };
  for (const member of team.members) {
    // An earlier finish can re-bind later members and bump their revision.
    const revision =
      control.snapshot().data?.agents.find((a) => a.id === member.id)
        ?.revision ?? member.revision;
    try {
      await finish(
        community,
        texts,
        member.id,
        revision,
        next.deleted ? "skipped" : "completed",
      );
      outcome.finished.push(member.id);
    } catch (reason) {
      outcome.failed.push(
        reason instanceof Error ? reason.message : String(reason),
      );
    }
  }
  return outcome;
}

/** The team step right after one agent is imported. Returns why its team
 * isn't finished yet, or `undefined` once nothing is left to do. Several old
 * Buzz texts wait for the user to pick one in Finish team setup. */
export async function setUpImportedTeam(
  kit: ChannelKit,
  control: AgentControl,
  community: string,
  teamId: string,
): Promise<string | undefined> {
  try {
    const team = (await control.betaTeams?.(community))?.find(
      (t) => t.teamId === teamId,
    );
    if (!team) return undefined;
    if (team.texts.length > 1)
      return `Members of "${team.name}" had different team instructions in old Buzz. Choose one in Finish team setup.`;
    const { failed } = await runBetaTeamStep(kit, control, community, team, {
      text: team.texts[0] ?? "",
    });
    return failed[0];
  } catch (reason) {
    return reason instanceof Error ? reason.message : String(reason);
  }
}
