import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  AgentControl,
  AgentControlState,
  BetaTeamRestorePreview,
  ImportSource,
  PendingBetaTeam,
} from "../../features/agents/control";
import { runBetaTeamStep } from "../../features/agents/beta-team-import";
import { sameCommunityAgents } from "../../features/agents/choices";
import { sessionCommunity } from "../../features/agents/team-instructions";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** One team's text choice: a single text needs no choice, several need one. */
function TextChoice({
  team,
  disabled,
  action,
  onChoose,
}: {
  team: PendingBetaTeam;
  disabled: boolean;
  action: string;
  onChoose: (text: string) => void;
}) {
  if (team.texts.length <= 1)
    return (
      <Button disabled={disabled} onClick={() => onChoose(team.texts[0] ?? "")}>
        {action}
      </Button>
    );
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-body-sm text-secondary">
        Members had different team instructions in old Buzz. Choose the ones
        this team keeps.
      </p>
      {team.texts.map((text, index) => (
        <div key={text} className="flex flex-col gap-1">
          <pre className="m-0 whitespace-pre-wrap text-body-sm">{text}</pre>
          <Button
            disabled={disabled}
            aria-label={`${action} with instructions ${index + 1}`}
            onClick={() => onChoose(text)}
          >
            Use these instructions
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Finishes teams carried over from old Buzz in the open community, and
 * restores them for agents imported before teams were recorded. Needs the
 * community's ready team catalog; until then agents simply stay pending. */
export function BetaTeamSetup({
  control,
  state,
  session,
  viewer,
}: {
  control: AgentControl;
  state: AgentControlState;
  session: RelaySession;
  viewer: string;
}) {
  const kit = useSyncExternalStore(
    session.channelKit.subscribe,
    session.channelKit.snapshot,
  );
  useEffect(() => session.channelKit.ensure(), [session]);
  const community = sessionCommunity(session.scope, viewer);
  const [pending, setPending] = useState<PendingBetaTeam[]>([]);
  const [preview, setPreview] = useState<BetaTeamRestorePreview | null>(null);
  const [source, setSource] = useState<ImportSource>("installed");
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const find = useRef<HTMLButtonElement>(null);
  const [refind, setRefind] = useState(false);
  const ready = kit.status === "ready" && state.status === "ready";
  // A refused restore needs a fresh preview. The control hides this section
  // until status is confirmed again, so wait for an enabled Find to exist.
  useEffect(() => {
    if (!refind || working || !ready || !find.current) return;
    find.current.focus();
    setRefind(false);
  }, [refind, working, ready]);
  const agents = sameCommunityAgents(state.data?.agents ?? [], session.scope);
  const unrecorded = agents.filter((agent) => agent.betaTeam === null);
  // Re-read whenever an agent's team status or revision changes.
  const statusKey = agents
    .map((a) => `${a.id}:${a.revision}:${a.betaTeam?.status ?? ""}`)
    .join(",");
  useEffect(() => {
    if (!ready || !control.betaTeams) return;
    let live = true;
    void statusKey;
    control.betaTeams(community).then(
      (teams) => live && setPending(teams),
      (reason) => live && setProblem(message(reason)),
    );
    return () => {
      live = false;
    };
  }, [control, community, ready, statusKey]);
  if (!ready || !control.finishBetaTeam) return null;
  const act = async (task: () => Promise<string | undefined>) => {
    setWorking(true);
    setProblem(null);
    try {
      setProblem((await task()) ?? null);
    } catch (reason) {
      setProblem(message(reason));
    } finally {
      setWorking(false);
    }
  };
  const finish = (team: PendingBetaTeam, text: string) =>
    act(async () => {
      const { failed } = await runBetaTeamStep(
        session.channelKit,
        control,
        community,
        team,
        { text },
      );
      return failed[0];
    });
  const restore = (
    preview: BetaTeamRestorePreview,
    group: PendingBetaTeam,
    text: string,
  ) =>
    act(async () => {
      if (!control.restoreBetaTeam || !control.betaTeams)
        throw new Error("Teams from old Buzz are unavailable.");
      await control
        .restoreBetaTeam(community, preview.token, group.teamId, text)
        .catch((reason) => {
          setRefind(true);
          throw reason;
        });
      setPreview(null);
      const team = (await control.betaTeams(community)).find(
        (t) => t.teamId === group.teamId,
      );
      if (!team) return undefined;
      const { failed } = await runBetaTeamStep(
        session.channelKit,
        control,
        community,
        team,
        { text },
      );
      return failed[0];
    });
  const canRestore =
    unrecorded.length > 0 &&
    !!control.restoreBetaTeams &&
    !!control.restoreBetaTeam;
  if (!pending.length && !canRestore) return null;
  return (
    <section
      aria-label="Teams from old Buzz"
      className="flex flex-col gap-3 text-body"
    >
      {pending.map((team) => (
        <div key={team.teamId} className="flex flex-col gap-2">
          <p className="m-0">
            Team “{team.name}” from old Buzz isn't set up yet for{" "}
            {team.members.length === 1
              ? "1 agent"
              : `${team.members.length} agents`}
            .
          </p>
          <TextChoice
            team={team}
            disabled={working}
            action={`Finish team setup for ${team.name}`}
            onChoose={(text) => void finish(team, text)}
          />
        </div>
      ))}
      {canRestore && (
        <div className="flex items-center gap-2">
          <label className="agent-control-field">
            <span>Old Buzz library</span>
            <select
              value={source}
              disabled={working}
              onChange={(event) => {
                // A preview belongs to the library it was found in.
                setPreview(null);
                setSource(event.target.value as ImportSource);
              }}
            >
              <option value="installed">Installed Buzz</option>
              <option value="development">Development Buzz</option>
            </select>
          </label>
          <Button
            ref={find}
            disabled={working}
            onClick={() =>
              void act(async () => {
                if (!control.restoreBetaTeams)
                  throw new Error("Teams from old Buzz are unavailable.");
                // Finding again can expire the shown token, even on failure.
                setPreview(null);
                const next = await control.restoreBetaTeams(
                  source,
                  unrecorded.map((agent) => agent.id),
                );
                setPreview(next);
                return next.groups.length
                  ? undefined
                  : "No teams from old Buzz were found for these agents.";
              })
            }
          >
            {preview ? "Find teams again" : "Find teams from old Buzz"}
          </Button>
        </div>
      )}
      {preview?.groups.map((group) => (
        <div key={group.teamId} className="flex flex-col gap-2">
          <p className="m-0">
            Restore team “{group.name}” for{" "}
            {group.members.length === 1
              ? "1 agent"
              : `${group.members.length} agents`}
            .
          </p>
          {group.inferred && (
            <p className="m-0 text-body-sm text-secondary">
              Old Buzz no longer lists this team, so it was put together from
              the agents' saved copies.
            </p>
          )}
          <TextChoice
            team={group}
            disabled={working}
            action={`Restore team ${group.name}`}
            onChoose={(text) => void restore(preview, group, text)}
          />
        </div>
      ))}
      {problem && <p role="alert">{problem}</p>}
    </section>
  );
}
