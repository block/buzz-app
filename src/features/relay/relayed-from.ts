import type { EventData } from "./events";

const HEX64 = /^[0-9a-f]{64}$/;

/** The signer's claim, in a signed `["relayed-from", <agent>, <source chat>?]`
 * tag, that another agent wrote this text and the signer relayed it. One
 * well-formed claim, or none: conflicting claims name no one. */
export function relayedFromClaim(
  event: Pick<EventData, "kind" | "tags">,
): { agent: string; channelId?: string } | undefined {
  if (event.kind !== 9) return undefined;
  const claims = event.tags.filter(([name]) => name === "relayed-from");
  const [claim] = claims;
  const agent = claim?.[1];
  if (claims.length !== 1 || !agent || !HEX64.test(agent)) return undefined;
  const channelId = claim[2];
  return channelId ? { agent, channelId } : { agent };
}

/** Text before the first blank line is the relaying sender's notice for clients
 * that do not read the tag. A client that draws attribution from the tag omits it. */
export function withoutRelayNotice(content: string) {
  const end = content.indexOf("\n\n");
  return end < 0 ? content : content.slice(end + 2).replace(/^\n+/, "");
}
