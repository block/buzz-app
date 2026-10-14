import type {
  Agent,
  Agents,
  AgentSession,
} from "../../features/agents/service";
import type {
  NavigationScope,
  OpenTarget,
} from "../../features/navigation/targets";
import type { ChannelSummary } from "../../features/relay/contracts";
import { replaceView, viewRevision } from "../../shared/view-state";
import { meTarget } from "../me/routes";

export type Row = Readonly<{ id: string; agent: Agent; session: AgentSession }>;

/** The selected community's agent sessions, most recent turn first. */
export function sessionRows(agents: Agents): Row[] {
  const types = new Map(agents.types().map((type) => [type.key, type]));
  return agents
    .snapshot()
    .agents.flatMap((agent) =>
      (types.get(agent.type)?.sessions?.list(agent.pubkey) ?? []).map(
        (session) => ({
          id: JSON.stringify([agent.pubkey, session.channelId, session.root]),
          agent,
          session,
        }),
      ),
    )
    .sort(
      (a, b) =>
        (b.session.at ?? 0) - (a.session.at ?? 0) || a.id.localeCompare(b.id),
    );
}

/** Where to message the session: its thread, Me chat, or channel or DM. */
export function targetOf(
  scope: NavigationScope,
  { channelId, root }: AgentSession,
  channel: ChannelSummary | undefined,
): OpenTarget {
  if (root)
    return {
      version: 1,
      kind: "conversation",
      scope,
      channelId,
      messageId: root,
      threadRootId: root,
    };
  if (channel?.channelType === "session")
    return meTarget(`${scope.communityOrigin}:${scope.viewer}`, channelId);
  return { version: 1, kind: "conversation", scope, channelId };
}

export const archiveKey = "switchboard:archives";
/** Archived row ids, each with the time it was archived through. */
type Archives = Readonly<Record<string, number>>;
const limit = 1000;

export function readArchives(revision: string | null | undefined): Archives {
  try {
    const value: unknown = revision && JSON.parse(revision);
    if (value && typeof value === "object" && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).filter(
          ([, through]) => Number.isSafeInteger(through) && through >= 0,
        ),
      );
  } catch {
    /* Malformed archives hide nothing. */
  }
  return {};
}

/** Archived until a turn starts after it was archived. */
export const isArchived = (archives: Archives, { id, session }: Row) =>
  id in archives && (archives[id] ?? 0) >= (session.at ?? 0);

export function updateArchive(
  scope: string,
  row: Row,
  archived: boolean,
  now = Date.now(),
) {
  const revision = viewRevision(scope, archiveKey);
  const { [row.id]: _, ...rest } = readArchives(revision);
  const next = Object.entries(rest).slice(archived ? 1 - limit : -limit);
  if (archived) next.push([row.id, Math.max(now, row.session.at ?? 0)]);
  const result = replaceView(
    scope,
    archiveKey,
    revision,
    Object.fromEntries(next),
  );
  if (result !== "saved")
    throw new Error(
      result === "changed"
        ? "Switchboard changed in another window. Try again."
        : "Could not save Switchboard on this device. Try again.",
    );
}
