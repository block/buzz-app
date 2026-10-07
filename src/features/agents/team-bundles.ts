import type { AgentControl, AgentEdit, AgentView } from "./control";

export interface MemberSnapshot {
  format: "buzz-agent-snapshot";
  version: 1;
  definition: {
    name: string;
    sourceIsBuiltin?: boolean;
    namePool?: string[];
    systemPrompt?: string | null;
    runtime?: string | null;
    model?: string | null;
    provider?: string | null;
    sessionPolicy?: "channel" | "thread";
    respondTo?: "owner-only" | "allowlist" | "anyone" | null;
    respondToAllowlist?: string[];
    parallelism?: number | null;
    idleTimeoutSeconds?: number | null;
    maxTurnDurationSeconds?: number | null;
  };
  profile: {
    displayName: string;
    about?: string | null;
    avatarDataUrl?: string | null;
    avatarUrl?: string | null;
  };
  memory: {
    level: "none" | "core" | "everything";
    entries?: { slug: string; body: string }[];
  };
}
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
  for (const [index, member] of snapshot.members.entries()) {
    const request = requests[index];
    if (!request) throw new Error("Invalid member creation request.");
    const state = control.snapshot().data;
    const options = state?.harnessOptions ?? [];
    const requested =
      member.definition.runtime ??
      state?.defaultSettings?.harness ??
      "buzz-agent";
    const chosen = options.find(
      (option) =>
        option.available !== false &&
        (option.command
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.exe$/i, "") === requested ||
          (requested === "goose" && option.command.endsWith("goose-acp"))),
    );
    if (!chosen)
      throw new Error(
        `No ACP runtimes found. Make sure an agent runtime (e.g. Goose) is installed.`,
      );
    const edit: AgentEdit = {
      name: member.profile.displayName,
      systemPrompt: member.definition.systemPrompt ?? "",
      sessionPolicy: member.definition.sessionPolicy ?? "channel",
      picture: member.profile.avatarDataUrl ?? member.profile.avatarUrl ?? "",
      workspace: state?.defaultWorkspace ?? "",
      harness: {
        command: chosen.command,
        args: chosen.defaultArgs ?? [],
        model: member.definition.model ?? "",
        provider: member.definition.provider ?? "",
      },
      environment: {
        BUZZ_ACP_AGENTS: String(member.definition.parallelism ?? 10),
      },
    };
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
): Promise<{ id: string; requests: string[]; complete(): void }> {
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
  const value = receipt as { id?: unknown; requests?: unknown };
  const uuid = (id: unknown): id is string =>
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
  if (
    !uuid(value.id) ||
    !Array.isArray(value.requests) ||
    value.requests.length !== snapshot.members.length ||
    !value.requests.every(uuid)
  )
    throw new Error("Saved team import receipt is invalid.");
  const result = { id: value.id, requests: value.requests as string[] };
  localStorage.setItem(key, JSON.stringify(result));
  return { ...result, complete: () => localStorage.removeItem(key) };
}
