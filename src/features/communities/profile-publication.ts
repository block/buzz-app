import { eventsDto, type RelayEvent } from "../relay/events.ts";
import type { EventTemplate } from "nostr-tools/pure";

const publishing = new Set<string>();

/** Host-local exclusion, shared by the profile editor and receiving updates.
 * Refuse overlap rather than queue an already stale replacement document. */
export function reserveProfilePublication(community: string, viewer: string) {
  const key = `${community}:${viewer}`;
  if (publishing.has(key))
    throw new Error(
      "A profile save is already in progress. Check your profile before saving again.",
    );
  publishing.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    publishing.delete(key);
  };
}

export function profilePublicationFilter(viewer: string) {
  return [
    { kinds: [0], authors: [viewer], limit: 5, consistency: "strong" as const },
  ];
}

export function profileHead(raw: unknown, viewer: string) {
  return eventsDto(raw)
    .filter((event) => event.kind === 0 && event.pubkey === viewer)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

export function nextProfileTimestamp(previous?: number) {
  const now = Math.floor(Date.now() / 1000);
  if (previous !== undefined && previous > now + 60)
    throw new Error("Your profile timestamp is ahead of this device's clock");
  return Math.max(now, (previous ?? -1) + 1);
}

/** The editor owns these fields; every other field comes from the fresh signed
 * head read by the host while it owns the publication reservation. */
export function editedProfileTemplate(
  input: { name: string; picture: string; about?: string },
  head: RelayEvent | undefined,
): EventTemplate {
  const metadata: unknown = head ? JSON.parse(head.content) : {};
  const existing: Record<string, unknown> =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const content = JSON.stringify({
    ...existing,
    name: input.name.trim(),
    display_name: input.name.trim(),
    picture: input.picture,
    about:
      input.about === undefined
        ? typeof existing.about === "string"
          ? existing.about
          : ""
        : input.about.trim(),
  });
  if (new TextEncoder().encode(content).length > 16000)
    throw new Error("Profile too large");
  return {
    kind: 0,
    content,
    tags: head?.tags ?? [],
    created_at: nextProfileTimestamp(head?.created_at),
  };
}

/** Detect observed conflicts after signing, before sending. The relay does not
 * offer conditional kind-0 publication; a remote writer can still race this read. */
export function assertReceivingProfileHead(
  raw: unknown,
  viewer: string,
  expected: string,
) {
  const head = profileHead(raw, viewer);
  if (head?.id !== expected)
    throw new Error(
      "Your profile changed while saving. Check your profile before saving again.",
    );
}
