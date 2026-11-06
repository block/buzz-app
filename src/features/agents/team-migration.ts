// Moving teams saved only on this device into their members' community, once
// its config channels are up. The move itself is an import (`adopt`) of the
// team under a deterministic id, so a rerun after a crash or disconnect lands
// in the same channel. The journal saves each move's community before its
// first write and whether its last try failed.
import type { AgentStore } from "./store";

export const TEAM_MOVES_KEY = "buzz.agents.teams.migration.v1";

/** A move under way: its community, fixed before the first write. */
export type TeamMove = Readonly<{ community: string; failed?: true }>;

/** Why a team stays on this device. */
export type LocalReason = "communities" | "unsupported" | "failed";

/** Where a team or agent's config lives, for its sync status line. */
export type SyncState =
  | Readonly<{ synced: string }>
  | Readonly<{ local: LocalReason | undefined }>;

/** Where a team of `members` moves: the one community every member is the
 * owner's agent in, unless the team's move began in another. */
export function moveHome(
  members: readonly string[],
  homesOf: (pubkey: string) => readonly string[],
  move: TeamMove | undefined,
): Readonly<{ home: string }> | Readonly<{ stay: "communities" | "none" }> {
  const homes = new Set(members.flatMap(homesOf));
  const [home] = homes;
  if (homes.size > 1) return { stay: "communities" };
  if (
    !home ||
    (move && move.community !== home) ||
    members.some((pubkey) => !homesOf(pubkey).includes(home))
  )
    return { stay: "none" };
  return { home };
}

/** The moves under way, by local team id. */
export class TeamMoves {
  private moves: Record<string, TeamMove> = {};
  constructor(private readonly storage: AgentStore) {
    try {
      const stored = JSON.parse(storage.get(TEAM_MOVES_KEY) ?? "null") as {
        version?: unknown;
        moves?: Record<string, unknown>;
      } | null;
      if (stored?.version === 1 && stored.moves)
        for (const [id, move] of Object.entries(stored.moves))
          if (typeof (move as TeamMove | null)?.community === "string")
            this.moves[id] = move as TeamMove;
    } catch {
      /* Malformed local data: moves start again from their teams. */
    }
  }
  get = (id: string): TeamMove | undefined => this.moves[id];
  /** Saves `move` for team `id`, or that it is done; settles once saved. */
  async set(id: string, move: TeamMove | undefined) {
    const prior = this.moves;
    const { [id]: _, ...rest } = prior;
    const next = move ? { ...rest, [id]: move } : rest;
    this.moves = next;
    try {
      await this.storage.set(
        TEAM_MOVES_KEY,
        JSON.stringify({ version: 1, moves: next }),
      );
    } catch (error) {
      // Memory never trusts what storage didn't take.
      if (this.moves === next) this.moves = prior;
      throw error;
    }
  }
}

const REASONS: Record<"team" | "agent", Record<LocalReason, string>> = {
  team: {
    communities: "Its agents are in different communities.",
    unsupported: "This community's relay doesn't sync teams.",
    failed: "Moving it to the community failed; Buzz will try again.",
  },
  agent: {
    communities: "",
    unsupported: "This community's relay doesn't sync agent settings.",
    failed: "Copying it to the community failed; Buzz will try again.",
  },
};

/** A sync status line: where it lives, and why it is only here. */
export function syncText(
  state: SyncState | undefined,
  of: "team" | "agent",
): SyncLine | undefined {
  if (!state) return undefined;
  const key = `${of} ${JSON.stringify(state)}`;
  let line = lines.get(key);
  if (!line) {
    line = Object.freeze(
      "synced" in state
        ? { title: `Synced in ${state.synced.replace(/^\w+:\/\//, "")}` }
        : {
            title: "Only on this Mac",
            ...(state.local && { reason: REASONS[of][state.local] }),
          },
    );
    lines.set(key, line);
  }
  return line;
}
export type SyncLine = Readonly<{ title: string; reason?: string }>;
/** One line per state, so a store snapshot of it stays the same object. */
const lines = new Map<string, SyncLine>();
