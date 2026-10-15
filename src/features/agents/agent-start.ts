// What an agent starts with, resolved synchronously from this device's storage
// and never from the relay (plan §4.1, §4.3). Each artifact type is in one mode:
// `local` and `migrating` start from the local row's own field; `synced` starts
// only from the confirmed copy in `AgentConfigStore`. `workspace` and anything
// outside the plugin's synced allowlist always come from the local row.
import {
  syncedSettings,
  type AgentConfigStore,
  type ArtifactState,
  type SettingsSchema,
  type Subject,
} from "./agent-config";
import type { Team } from "./store";

export type Mode = "local" | "migrating" | "synced";

/** One team config channel that lists the agent as a member. */
export type TeamSource = Readonly<{
  id: string;
  lifecycle: "active" | "archived" | "unreadable";
  subject: Subject;
  members: readonly string[];
}>;

export type StartInput<C extends { instructions: string }> = Readonly<{
  store: AgentConfigStore;
  /** This device's row: the launch source in `local`/`migrating`, and the
   * only source of `workspace` and unsynced fields in every mode. */
  local: C;
  agentType: string;
  schema: SettingsSchema;
  withSynced: (config: C, settings: Readonly<Record<string, string>>) => C;
  settings: Readonly<{ mode: Mode; subject: Subject }>;
  instructions: Readonly<{ mode: Mode; subject: Subject }>;
  /** Teams from the synced store; `undefined` while teams are still local. */
  teams?: readonly TeamSource[];
}>;

export type Start<C> =
  | Readonly<{
      ok: true;
      config: C;
      teams?: readonly Team[];
      /** The synced revisions this start used, for "Restart to apply". */
      revisions: readonly string[];
    }>
  | Readonly<{ ok: false; state: ArtifactState; reason: string }>;

const WAITING = "Waiting for this agent's config to sync";
const blocked = (
  state: ArtifactState,
  problem: string | undefined,
  what: string,
) => ({
  ok: false as const,
  state,
  reason:
    state === "deleted"
      ? `${what} were deleted — restore from History`
      : state === "invalid"
        ? `${what} can't be used: ${problem ?? "invalid"}`
        : WAITING,
});

/** Pure over storage: never reads the relay. Once this device has had any
 * synced revision of a type, its local field is never a launch source again.
 * A transport failure never changes a stored state, so a confirmed `present`
 * head keeps serving while the relay is unreachable (offline rule, §4.4);
 * `invalid`, `deleted` and lost access block. */
export function resolveStart<C extends { instructions: string }>(
  input: StartInput<C>,
): Start<C> {
  const { store } = input;
  const synced = (side: StartInput<C>["settings"]) =>
    side.mode === "synced" || store.hadVersion(side.subject);
  const revisions: string[] = [];
  let config = input.local;

  if (synced(input.settings)) {
    const entry = store.state(input.settings.subject);
    if (entry.state !== "present" || !entry.head)
      return blocked(entry.state, entry.problem, "Settings");
    const read = syncedSettings(
      entry.head.content,
      input.agentType,
      input.schema,
    );
    if ("problem" in read) return blocked("invalid", read.problem, "Settings");
    config = input.withSynced(config, read.settings);
    revisions.push(entry.head.id);
  }
  if (synced(input.instructions)) {
    const entry = store.state(input.instructions.subject);
    const text = store.instructions(input.instructions.subject);
    if (!text.ok) return blocked(text.state, text.problem, "Instructions");
    config = { ...config, instructions: text.text };
    if (entry.head) revisions.push(entry.head.id);
  }
  if (!input.teams) return { ok: true, config, revisions };

  const teams: Team[] = [];
  for (const team of input.teams) {
    // An archived team has no members (NIP-AP "Deleting a team").
    if (team.lifecycle === "archived") continue;
    const entry = store.state(team.subject);
    if (
      team.lifecycle === "unreadable" ||
      entry.state !== "present" ||
      !entry.head
    ) {
      const name = entry.head ? teamName(entry.head.content) : team.id;
      return {
        ok: false,
        state: team.lifecycle === "unreadable" ? "unavailable" : entry.state,
        reason: `Team ${JSON.stringify(name)} isn't available: ${WAITING.toLowerCase()}`,
      };
    }
    const body = JSON.parse(entry.head.content) as {
      name: string;
      instructions: string;
    };
    teams.push({
      id: team.id,
      name: body.name,
      instructions: body.instructions,
      members: team.members,
    });
    revisions.push(entry.head.id);
  }
  return { ok: true, config, teams, revisions };
}

function teamName(content: string) {
  try {
    const name = (JSON.parse(content) as { name?: unknown }).name;
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

/** Why a running agent's config changed. */
export type Change = "local" | "remote" | "team";

/** Tracks the synced revisions each agent's current run started from (§4.5):
 * a local save restarts that agent; a remote change only marks it "Restart to
 * apply"; a team save restarts no one, and the next start uses the new copy. */
export class Runs {
  private readonly started = new Map<string, readonly string[]>();
  private readonly stale = new Set<string>();

  start(agent: string, revisions: readonly string[]) {
    this.started.set(agent, revisions);
    this.stale.delete(agent);
  }
  revisions = (agent: string) => this.started.get(agent);
  restartToApply = (agent: string) => this.stale.has(agent);

  /** What to do with `agent`'s run after a change whose current revisions are
   * `current`. */
  changed(
    agent: string,
    change: Change,
    current: readonly string[],
  ): "restart" | "restart-to-apply" | "none" {
    const started = this.started.get(agent);
    if (!started) return "none";
    if (change === "local") return "restart";
    if (change === "team" || sameSet(started, current)) return "none";
    this.stale.add(agent);
    return "restart-to-apply";
  }
}
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));
