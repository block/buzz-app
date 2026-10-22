import type { VerifiedEvent } from "nostr-tools";

// Wire contract only: no imports beyond types, so the browser broker can load it.
/** NIP-AR sync (docs/nips/NIP-AR.md "Sync" in block/buzz): a REQ with one
 * `"artifact": "current"` filter. `#h` is required; paging keys are refused. */
export type ArtifactSyncFilter = Readonly<{
  artifact: "current";
  kinds?: readonly [45010];
  "#h": readonly string[];
  [tag: `#${string}`]: readonly string[] | undefined;
}>;

export const ARTIFACT_REVISION_KIND = 45010;
export const ARTIFACT_REMOVAL_KIND = 45011;
/** The relay's own `#h` bound for one sync. */
export const ARTIFACT_SYNC_MAX_CHANNELS = 256;
const MAX_TAG_VALUES = 256;

/** Low-level sink for one REQ on one socket. No retry: the caller owns restart. */
export type ArtifactSyncSink = {
  event(event: VerifiedEvent): void;
  eose(): void;
  /** Relay CLOSED reason, or `disconnected: ...` when the socket went away. */
  closed(reason: string): void;
};

/** Validate and copy a plugin-supplied filter. Throws on anything the relay
 * would refuse, so a bad filter fails at the call site, not as a CLOSED. */
export function artifactSyncFilter(input: unknown): ArtifactSyncFilter {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Artifact sync filter must be an object");
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input)) {
    if (name === "artifact") {
      if (value !== "current")
        throw new Error('Artifact sync needs "artifact": "current"');
      out.artifact = value;
    } else if (name === "kinds") {
      if (
        !Array.isArray(value) ||
        value.length !== 1 ||
        value[0] !== ARTIFACT_REVISION_KIND
      )
        throw new Error("Artifact sync kinds must be [45010]");
      out.kinds = [ARTIFACT_REVISION_KIND];
    } else if (/^#[A-Za-z0-9_.:-]{1,64}$/.test(name)) {
      if (
        !Array.isArray(value) ||
        !value.length ||
        (name !== "#h" && value.length > MAX_TAG_VALUES) ||
        value.some((item) => typeof item !== "string" || item.length > 1024)
      )
        throw new Error(`Invalid artifact sync tag values for ${name}`);
      out[name] = [...new Set(value as string[])].sort();
    } else throw new Error(`Artifact sync does not accept "${name}"`);
  }
  if (out.artifact !== "current")
    throw new Error('Artifact sync needs "artifact": "current"');
  const channels = out["#h"];
  if (!Array.isArray(channels) || !channels.length)
    throw new Error("Artifact sync needs #h with at least one channel");
  if (channels.length > ARTIFACT_SYNC_MAX_CHANNELS)
    throw new Error(
      `Artifact sync accepts at most ${ARTIFACT_SYNC_MAX_CHANNELS} channels`,
    );
  return Object.freeze(out) as ArtifactSyncFilter;
}
