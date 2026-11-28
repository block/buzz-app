export type InstallOnlyRecommendation = { source: string; id: string };

/** Distributor selectors, separate from policy bytes so cached v1 files still work. */
export function parseInstallOnlyRecommendations(
  raw: string,
): InstallOnlyRecommendation[] {
  if (!raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          Object.keys(entry).length === 2 &&
          typeof entry.source === "string" &&
          entry.source.trim().length > 0 &&
          typeof entry.id === "string" &&
          entry.id.trim().length > 0,
      )
    )
      return parsed;
  } catch {}
  throw new Error(
    "Install-only recommendations must be a JSON list of source and id selectors.",
  );
}
