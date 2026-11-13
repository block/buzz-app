import { verifyEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import { nextProfileTimestamp } from "./profile-publication.ts";

/** The host accepts an existing, own signed profile and one address (or null to
 * clear), never an arbitrary replacement document or general identity signing. */
export function receivingProfileTemplate(
  input: unknown,
  viewer: string,
): EventTemplate {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid receiving profile update");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["address", "profile"].includes(key)))
    throw new Error("Invalid receiving profile update");
  const address =
    value.address === null ? null : receivingAddress(value.address);
  const profile = value.profile as Event;
  if (
    profile?.kind !== 0 ||
    profile.pubkey !== viewer ||
    typeof profile.content !== "string" ||
    profile.content.length > 16000 ||
    !verifyEvent({
      id: profile.id,
      pubkey: profile.pubkey,
      created_at: profile.created_at,
      kind: profile.kind,
      tags: profile.tags,
      content: profile.content,
      sig: profile.sig,
    })
  )
    throw new Error("A signed profile for this Buzz account is required");
  const metadata: unknown = JSON.parse(profile.content);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Invalid profile metadata");
  const next: Record<string, unknown> = { ...metadata };
  if (address === null) delete next.lud16;
  else next.lud16 = address;
  delete next.lud06;
  const content = JSON.stringify(next);
  if (new TextEncoder().encode(content).length > 16000)
    throw new Error("Profile too large");
  return {
    kind: 0,
    content,
    tags: profile.tags,
    created_at: nextProfileTimestamp(profile.created_at),
  };
}

/** Only fixed host validation/conflict guidance may cross the browser boundary. */
export function receivingProfileError(reason: unknown): string | undefined {
  const known = [
    "Invalid receiving profile update",
    "Enter a Lightning address",
    "Enter a valid Lightning address",
    "A signed profile for this Buzz account is required",
    "Invalid profile metadata",
    "Profile too large",
    "Your profile timestamp is ahead of this device's clock",
    "A profile save is already in progress. Check your profile before saving again.",
    "Your profile changed while saving. Check your profile before saving again.",
  ];
  return typeof reason === "string" && known.includes(reason)
    ? reason
    : undefined;
}

export function receivingAddress(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a Lightning address");
  const address = value.trim();
  if (
    address.length > 254 ||
    !/^[a-z0-9_.+-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(
      address,
    )
  )
    throw new Error("Enter a valid Lightning address");
  return address;
}
