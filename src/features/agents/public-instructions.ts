import { AGENT_CATALOG_KIND } from "./catalog-envelope";
import { sharedAgents } from "./shared-agents";
import type { RelaySession } from "../relay/session";

/** Evidence of instruction text published in this community's Marketplace.
 * It does not approve sending that text to any particular provider. */
export type PublicInstructions = Readonly<{
  community: string;
  event: string;
  sha256: string;
}>;

/** Verify the live catalog head rather than trusting an import's source label.
 * One bounded relay read at import; routing never scans the catalog. */
export async function verifyPublicInstructions(
  session: Pick<RelaySession, "read">,
  community: string,
  catalog: string | undefined,
  instructions: string | undefined,
): Promise<PublicInstructions | undefined> {
  if (!catalog || !instructions) return;
  const match = /^([0-9a-f]{64}):([a-z0-9][a-z0-9_-]{0,63})$/.exec(catalog);
  if (!match?.[1] || !match[2]) return;
  try {
    const events = await session.read([
      {
        kinds: [AGENT_CATALOG_KIND],
        authors: [match[1]],
        "#d": [match[2]],
        limit: 1,
      },
    ]);
    const event = events[0];
    if (
      !event ||
      event.pubkey !== match[1] ||
      !event.tags.some(([name, value]) => name === "d" && value === match[2]) ||
      sharedAgents([event])[0]?.instructions !== instructions
    )
      return;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(instructions),
    );
    return {
      community,
      event: event.id,
      sha256: Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join(""),
    };
  } catch {
    // Missing or unreadable evidence never makes private instructions public.
    return;
  }
}
