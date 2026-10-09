import type { AgentControl, AgentView } from "./control";

import {
  parseAgentSnapshot,
  snapshotImportEdit,
  type AgentSnapshot,
} from "./snapshot";

export type MemberSnapshot = AgentSnapshot;
export interface TeamSnapshot {
  format: "buzz-team-snapshot";
  version: 1;
  team: {
    name: string;
    description?: string | null;
    instructions?: string | null;
  };
  members: MemberSnapshot[];
}
export interface BundleMember {
  team: string;
  member: MemberSnapshot;
  instructions: string;
  keepAllowlist: boolean;
}

/** The native receipt is stored with each saved identity, including on partial failure. */
export async function importTeamMembers(
  control: AgentControl,
  snapshot: TeamSnapshot,
  requests: readonly string[],
  destination: string,
  owner: string,
  keepAllowlist: boolean,
  team: string,
): Promise<AgentView[]> {
  if (!control.create || requests.length !== snapshot.members.length)
    throw new Error("Agent creation is unavailable.");
  const agents: AgentView[] = [];
  // An uncertain commit requires a fresh native read before any explicit retry.
  await control.refresh();
  // Validate every member against the shared foundation before creating any copy.
  const state = control.snapshot().data;
  const edits = snapshot.members.map((member) =>
    snapshotImportEdit(
      parseAgentSnapshot(new TextEncoder().encode(JSON.stringify(member)), {
        teamMember: true,
      }),
      { ...state, teamMember: true },
    ),
  );
  for (const [index, member] of snapshot.members.entries()) {
    const request = requests[index];
    const edit = edits[index];
    if (!request || !edit) throw new Error("Invalid member creation request.");
    const agent = await control.create(request, destination, owner, edit, {
      member: { ...member, memory: { level: "none", entries: [] } },
      team,
      instructions: snapshot.team.instructions ?? "",
      keepAllowlist,
    });
    agents.push(agent);
  }
  return agents;
}

/** Persist only public operation IDs, never instructions, snapshots, or memories. */
export async function resumeTeamImport(
  snapshot: TeamSnapshot,
  destination: string,
  owner: string,
  channelId = "",
  keepAllowlist = false,
): Promise<{
  id: string;
  requests: string[];
  /** Revision for the team's text head. */
  text: string;
  /** The text head this import enqueued, once it has. */
  textHead: string | undefined;
  textEnqueued(id: string): void;
  complete(): void;
}> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([destination, owner, channelId, keepAllowlist, snapshot]),
  );
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const key = `buzz-team-import:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const raw = localStorage.getItem(key);
  const receipt: unknown = raw
    ? JSON.parse(raw)
    : {
        id: crypto.randomUUID(),
        requests: snapshot.members.map(() => crypto.randomUUID()),
      };
  const value = receipt as {
    id?: unknown;
    requests?: unknown;
    text?: unknown;
    textHead?: unknown;
  };
  const uuid = (id: unknown): id is string =>
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
  if (
    !uuid(value.id) ||
    !Array.isArray(value.requests) ||
    value.requests.length !== snapshot.members.length ||
    !value.requests.every(uuid) ||
    (value.text !== undefined && !uuid(value.text)) ||
    (value.textHead !== undefined &&
      (typeof value.textHead !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.textHead)))
  )
    throw new Error("Saved team import receipt is invalid.");
  // Receipts from before team-text heads get a text revision on resume.
  const result = {
    id: value.id,
    requests: value.requests as string[],
    text: value.text ?? crypto.randomUUID(),
    textHead: value.textHead as string | undefined,
  };
  localStorage.setItem(key, JSON.stringify(result));
  return {
    ...result,
    textEnqueued(id: string) {
      result.textHead = id;
      localStorage.setItem(key, JSON.stringify(result));
    },
    complete: () => localStorage.removeItem(key),
  };
}
