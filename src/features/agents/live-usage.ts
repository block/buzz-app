/** A provider allowance window, as a provider reported it. Unknown values stay
 * absent: zero is a real observation. Timestamps are Unix milliseconds. */
export type UsageAllowance = Readonly<{
  id: string;
  label: string;
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: number;
}>;

/** Account and allowance state shared by native conversation usage surfaces.
 * It deliberately excludes account identifiers, emails and credentials. */
export type ProviderUsageSnapshot = Readonly<{
  provider: string;
  surface: "chatgpt-subscription" | "claude-subscription" | "api" | "unknown";
  observedAt: number;
  freshness: "live" | "stale" | "unavailable" | "error";
  account?: Readonly<{
    state: "signed-in" | "signed-out" | "unknown";
    plan?: string;
  }>;
  allowances: readonly UsageAllowance[];
  credits?: Readonly<{ balance?: string; unlimited?: boolean }>;
  reason?: string;
}>;

/** The live usage of the current run. Provider account reads do not need to
 * know the conversation that produced it. */
export type RunUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsed?: number;
  contextSize?: number;
  costUsd?: number;
}>;

export type LiveUsageSnapshot = ProviderUsageSnapshot &
  Readonly<{
    schemaVersion: 1;
    agent: string;
    conversation: string;
    run?: RunUsage;
  }>;

/** A finite percentage within the provider contract. */
export function usagePercent(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : undefined;
}

/** A finite non-negative count. */
export function usageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
