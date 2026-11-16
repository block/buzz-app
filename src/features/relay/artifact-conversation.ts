// NIP-AR conversations (buzz-artifact-conversations): an artifact's comments
// live in a hidden channel of type `artifact` whose id comes from the
// artifact's `d` alone, so anyone who can read the artifact finds it with no
// lookup. The relay makes it on an opening kind:9007, under the artifact's
// home and with no members; who reads and posts there comes from the home.
import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "./events";

export const ARTIFACT_CONVERSATIONS_EXTENSION = "buzz-artifact-conversations";

const encoder = new TextEncoder();

/** Whether the relay advertises artifact conversations in NIP-11. */
export function artifactConversationsCapability(info: unknown): boolean {
  const extensions = (info as { supported_extensions?: unknown } | undefined)
    ?.supported_extensions;
  return (
    Array.isArray(extensions) &&
    extensions.includes(ARTIFACT_CONVERSATIONS_EXTENSION)
  );
}

/** The conversation id for artifact `d`: UUIDv8 of the first 16 bytes of
 * SHA-256("nip-ar-conversation\0" + d), over the UTF-8 bytes of `d`. */
export async function artifactConversationId(d: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`nip-ar-conversation\0${d}`),
    ),
  ).slice(0, 16);
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x80;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The kind:9007 that opens artifact `d`'s conversation. */
export async function conversationOpening(
  d: string,
  createdAt = Math.floor(Date.now() / 1000),
): Promise<EventTemplate> {
  if (!d) throw new Error("A conversation needs its artifact.");
  return {
    kind: 9007,
    created_at: createdAt,
    content: "",
    tags: [
      ["h", await artifactConversationId(d)],
      ["artifact", d],
    ],
  };
}

/** Whether `event` is exactly an opening: kind:9007, empty, and only the
 * derived `h` with its `artifact`. Nothing else may pass this writer. */
export async function isConversationOpening(
  event: EventTemplate | RelayEvent,
): Promise<boolean> {
  if (event.kind !== 9007 || event.content !== "" || event.tags.length !== 2)
    return false;
  const [h, artifact] = event.tags;
  if (h?.[0] !== "h" || artifact?.[0] !== "artifact") return false;
  if (h.length !== 2 || artifact.length !== 2 || !artifact[1]) return false;
  return h[1] === (await artifactConversationId(artifact[1]));
}
