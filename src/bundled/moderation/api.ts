// Community membership (NIP-43 kind 13534) and owner/admin requests through the
// development broker. Roles here only shape the UI; the relay decides every change.
import type { EventData } from "../../features/relay/events";
import { communityRequest } from "../../features/communities/api";

export type Role = "owner" | "admin" | "member";
export type Member = { pubkey: string; role: Role };
export type Invite = {
  code: string;
  url: string;
  expires_at: number;
  max_uses: number | null;
  uses_remaining: number | null;
};
export type MemberChange =
  | { action: "add" | "role"; pubkey: string; role: "admin" | "member" }
  | { action: "remove"; pubkey: string };

export const MEMBERSHIP_KIND = 13534;
const ROLES: readonly string[] = ["owner", "admin", "member"];

/** Members from the relay-signed snapshot (`["member", pubkey, role]` tags). */
export function membersFromSnapshot(
  event: EventData,
  relayAuthor: string,
): Member[] {
  if (event.kind !== MEMBERSHIP_KIND || event.pubkey !== relayAuthor)
    throw new Error("Member list is not signed by this community");
  const members = new Map<string, Member>();
  for (const [name, pubkey, role] of event.tags) {
    if (name !== "member" || !pubkey || !/^[0-9a-f]{64}$/.test(pubkey))
      continue;
    if (members.has(pubkey)) continue;
    members.set(pubkey, {
      pubkey,
      role: role && ROLES.includes(role) ? (role as Role) : "member",
    });
  }
  return [...members.values()];
}

/** The community's relay signing key, from the broker session contract. */
export const relayAuthor = async (community: string) =>
  (await communityRequest<{ relayAuthor: string }>(community, "session"))
    .relayAuthor;

export type Action = "promote" | "demote" | "remove";
/** Actions the relay's permission matrix would allow `actor` to take on `target`. */
export function allowedActions(
  actor: Role | undefined,
  target: Member,
  self: boolean,
): Action[] {
  if (self || target.role === "owner") return [];
  if (actor === "admin") return target.role === "member" ? ["remove"] : [];
  if (actor !== "owner") return [];
  return [target.role === "admin" ? "demote" : "promote", "remove"];
}

export const mintInvite = (
  community: string,
  ttl_secs: number,
  max_uses: number | null,
) => communityRequest<Invite>(community, "invite", { ttl_secs, max_uses });

export async function changeMember(community: string, change: MemberChange) {
  const receipt = await communityRequest<{
    accepted?: boolean;
    message?: string;
  }>(community, "member", change);
  if (!receipt.accepted)
    throw new Error(receipt.message || "The relay did not accept the change");
}
