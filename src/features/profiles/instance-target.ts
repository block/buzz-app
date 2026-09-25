import { relayOrigin } from "../communities/destination";
import { sameCommunityAgents } from "../agents/choices";
import type { AgentView } from "../agents/control";

/** A native record is not an identity alias or an authorization grant. */
export type InstanceTarget = Readonly<{
  id: string;
  pubkey: string;
  viewer: string;
  communityOrigin: string;
}>;
const prefix = "buzz:agent-instance:";
export function instanceTarget(value: InstanceTarget): string {
  return `${prefix}${encodeURIComponent(JSON.stringify(value))}`;
}
export function parseInstanceTarget(
  target: string,
): InstanceTarget | undefined {
  if (!target.startsWith(prefix) || target.length > 4096) return;
  try {
    const value = JSON.parse(decodeURIComponent(target.slice(prefix.length)));
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).sort().join() !== "communityOrigin,id,pubkey,viewer" ||
      typeof value.id !== "string" ||
      !value.id.trim() ||
      value.id.length > 256 ||
      typeof value.pubkey !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.pubkey) ||
      typeof value.viewer !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.viewer) ||
      typeof value.communityOrigin !== "string" ||
      relayOrigin(value.communityOrigin) !== value.communityOrigin
    )
      return;
    return value;
  } catch {
    return;
  }
}
export function exactProfileAgent(
  agents: readonly AgentView[],
  scope: string,
  pubkey: string,
  id?: string,
): AgentView | undefined {
  const matches = sameCommunityAgents(agents, scope).filter(
    (agent) => agent.pubkey === pubkey && (id === undefined || agent.id === id),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
