// A recommended agent setup: candidates in priority order, each a harness with
// its provider, model and thinking level, compiled in from
// `BUZZ_RECOMMENDED_AGENT` (docs/configuration.md). An agent on Recommended
// saves only `preset: "recommended"` in its config. Its type runs it on the
// first candidate for its harness whose model is still offered, found once per
// launch, so a later build's recommendation reaches it; with none, it runs on
// the harness's own default. Its harness is never changed for it.
// The build config parses candidates too, so this module imports nothing.

export type RecommendedCandidate = Readonly<{
  /** The agent type's id: `codex`, `goose` or `claude-code`. */
  harness: string;
  /** goose's provider; Codex takes none. */
  provider?: string;
  model: string;
  effort: string;
  /** The model's display name, e.g. `Model A`. */
  label: string;
}>;

export const PRESET = "recommended";
/** The agent types that follow a candidate, and whether each needs a provider. */
const HARNESSES: Readonly<Record<string, boolean>> = {
  codex: false,
  goose: true,
  "claude-code": false,
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
      throw invalid(`${at}.harness must be goose, codex or claude-code.`);
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

/** Whether a config is on Recommended: marked, with no model settings of its
 * own. A model choice synced in, as from History or an older version that
 * kept the mark, takes the agent off it. */
export function onRecommended(config: unknown) {
  if (typeof config !== "object" || config === null) return false;
  const saved = config as Record<string, unknown>;
  return (
    saved.preset === PRESET &&
    ["model", "provider", "effort"].every(
      (name) => saved[name] === undefined || saved[name] === "",
    )
  );
}

/** `config` on Recommended. Its own model settings go, so neither a run nor
 * its synced settings hold one the recommendation would contradict. */
export function withRecommended<C extends object>(config: C): C {
  const {
    model: _,
    provider: __,
    effort: ___,
    ...rest
  } = config as C & {
    model?: unknown;
    provider?: unknown;
    effort?: unknown;
  };
  return { ...rest, preset: PRESET } as C;
}

/** `config` off Recommended, keeping whatever else it holds. */
export function offRecommended<C extends object>(config: C): C {
  if (!("preset" in config)) return config;
  const { preset: _, ...rest } = config as C & { preset?: unknown };
  return rest as C;
}

/** A type's parsed `config` with `candidate`'s model settings, when `saved` is
 * on Recommended. Without a candidate its own blank settings stay, which run
 * on the harness's default. */
export function followRecommended<
  C extends Readonly<{ model: string; effort: string }>,
>(
  saved: unknown,
  config: C,
  candidate: RecommendedCandidate | null | undefined,
): C {
  if (!candidate || !onRecommended(saved)) return config;
  return {
    ...config,
    model: candidate.model,
    effort: candidate.effort,
    ...("provider" in config ? { provider: candidate.provider ?? "" } : {}),
  };
}

/** How long one harness may take to say whether it can run a candidate. */
export const CHECK_MS = 8_000;
/** How long a launch keeps a finding that found nothing, before a harness
 * set up or signed in since then is asked again. */
export const RETRY_MS = 60_000;
/** A check's answer, as no once it rejects or takes longer than `CHECK_MS`. */
const bounded = (check: Promise<boolean> | undefined) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), CHECK_MS);
    const done = (answer: boolean) => {
      clearTimeout(timer);
      resolve(answer);
    };
    (check ?? Promise.resolve(false)).then(done, () => done(false));
  });

/** What one harness's agents on Recommended run on, found once per launch. */
export type RecommendedRun = Readonly<{
  /** Undefined until found; `null` when none of the candidates is offered. */
  current(): RecommendedCandidate | null | undefined;
  /** Finds it, or joins the finding already done or under way. A finding
   * that found nothing is done again after `RETRY_MS`. */
  find(): Promise<RecommendedCandidate | null>;
  subscribe(listener: () => void): () => void;
}>;

/** The first of `harness`'s candidates `offered` confirms within `CHECK_MS`;
 * a failed or slow check moves on to the next. */
export function recommendedRun(
  harness: string,
  offered: (candidate: RecommendedCandidate) => Promise<boolean>,
): RecommendedRun {
  let found: RecommendedCandidate | null | undefined;
  let finding: Promise<RecommendedCandidate | null> | undefined;
  /** When a finding last found nothing. */
  let emptyAt: number | undefined;
  const listeners = new Set<() => void>();
  return {
    current: () => found,
    find: () => {
      if (emptyAt !== undefined && Date.now() - emptyAt >= RETRY_MS) {
        finding = undefined;
        emptyAt = undefined;
      }
      finding ??= (async () => {
        for (const candidate of candidatesFor(harness))
          if (await bounded(offered(candidate))) return candidate;
        emptyAt = Date.now();
        return null;
      })().then((candidate) => {
        found = candidate;
        for (const listener of listeners)
          try {
            listener();
          } catch (error) {
            console.warn("A recommended agent setup listener failed", error);
          }
        return candidate;
      });
      return finding;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The agent type fields a pick reads. */
type Harness = Readonly<{
  id: string;
  title: string;
  remote?: unknown;
  recommends?(candidate: RecommendedCandidate): Promise<boolean>;
}>;
export type RecommendedPick<T extends Harness = RegisteredType> = Readonly<{
  type: T;
  candidate: RecommendedCandidate;
  /** Other installed harnesses ahead of it that aren't ready here. */
  skipped: readonly T[];
}>;
type RegisteredType = import("./service").RegisteredAgentType;

/** One line when Automatic skipped a preferred harness, never the order. */
export const recommendedNote = (pick: RecommendedPick<Harness>) => {
  const [first] = pick.skipped;
  return first
    ? `${first.title} isn’t set up on this computer, so this uses ${pick.type.title}.`
    : undefined;
};

/** The first candidate this computer can run now: its harness is installed
 * here (Codex and Claude Code are not on Windows), follows Recommended, and says, within
 * `CHECK_MS`, that it is ready and offers the candidate's model. Undefined
 * when none is. */
export async function pickRecommended<T extends Harness>(
  types: readonly T[],
): Promise<RecommendedPick<T> | undefined> {
  const skipped: T[] = [];
  for (const candidate of recommendedCandidates()) {
    const type = types.find(
      (item) =>
        item.id === candidate.harness && item.recommends && !item.remote,
    );
    if (!type) continue;
    if (await bounded(type.recommends?.(candidate)))
      return {
        type,
        candidate,
        skipped: skipped.filter((item) => item !== type),
      };
    if (!skipped.includes(type)) skipped.push(type);
  }
  return undefined;
}
