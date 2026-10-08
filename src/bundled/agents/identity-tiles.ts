import type { AgentLibrary } from "../../features/agents/library";

export function identityTiles(
  library: AgentLibrary,
  archived: (key: string) => boolean,
) {
  const linked = new Set(library.identities.map((row) => row.definitionId));
  const identities = [
    ...new Map(
      library.identities.map((row) => [row.pubkey.toLowerCase(), row]),
    ).values(),
  ]
    // Artwork inheritance already happened where the library snapshot was made.
    .filter((row) => !archived(row.pubkey));
  return {
    identities,
    profiles: library.definitions.filter((row) => !linked.has(row.id)),
  };
}
