// A recommended agent setup: candidates in priority order, each a harness with
// its provider, model and thinking level, compiled in from
// `BUZZ_RECOMMENDED_AGENT` (docs/configuration.md).
// The build config parses candidates too, so this module imports nothing.

export type RecommendedCandidate = Readonly<{
  /** The agent type's id: `codex` or `goose`. */
  harness: string;
  /** goose's provider; Codex takes none. */
  provider?: string;
  model: string;
  effort: string;
  /** The model's display name, e.g. `Model A`. */
  label: string;
}>;

/** The agent types that follow a candidate, and whether each needs a provider. */
const HARNESSES: Readonly<Record<string, boolean>> = {
  codex: false,
  goose: true,
};

const filled = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && value !== "";

/** The candidates in `value`, a JSON array; empty for an empty value. Throws
 * on anything else, naming the setting, and the candidate and field at fault,
 * but never echoing a value. */
export function parseRecommended(
  value: string,
): readonly RecommendedCandidate[] {
  if (!value.trim()) return [];
  const invalid = (problem: string) =>
    new Error(`BUZZ_RECOMMENDED_AGENT${problem}`);
  let list: unknown;
  try {
    list = JSON.parse(value);
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list) || !list.length)
    throw invalid(
      " must be a JSON array of {harness, provider, model, effort, label} candidates.",
    );
  return list.map((item: unknown, index) => {
    const at = `[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw invalid(`${at} must be an object.`);
    const { harness, provider, model, effort, label, ...rest } = item as Record<
      string,
      unknown
    >;
    const needsProvider =
      typeof harness === "string" && Object.hasOwn(HARNESSES, harness)
        ? HARNESSES[harness]
        : undefined;
    if (needsProvider === undefined)
      throw invalid(`${at}.harness must be goose or codex.`);
    const [unknown] = Object.keys(rest);
    if (unknown !== undefined)
      throw invalid(`${at} has an unknown field, "${unknown}".`);
    for (const [name, field] of Object.entries({ model, effort, label }))
      if (!filled(field))
        throw invalid(`${at}.${name} must be text without surrounding spaces.`);
    if (needsProvider ? !filled(provider) : provider !== undefined)
      throw invalid(
        needsProvider
          ? `${at}.provider must be text without surrounding spaces.`
          : `${at}.provider is only for goose.`,
      );
    return Object.freeze({
      harness: harness as string,
      ...(needsProvider ? { provider: provider as string } : {}),
      model: model as string,
      effort: effort as string,
      label: label as string,
    });
  });
}

/** This build's candidates, in priority order; the build rejected bad ones. */
export function recommendedCandidates(): readonly RecommendedCandidate[] {
  try {
    return parseRecommended(
      String(import.meta.env.VITE_BUZZ_RECOMMENDED_AGENT ?? ""),
    );
  } catch {
    return [];
  }
}

/** `harness`'s candidates, in priority order. */
export const candidatesFor = (harness: string) =>
  recommendedCandidates().filter((candidate) => candidate.harness === harness);
