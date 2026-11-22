import {
  type ProviderUsageSnapshot,
  usageCount,
  usagePercent,
} from "../../features/agents/live-usage";
import { Refused, type Spawn } from "./rpc";
import { withServer } from "./transcript";

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;

const text = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const plan = (value: unknown) => {
  const candidate = text(value);
  return candidate &&
    candidate.length <= 40 &&
    /^[\p{L}\p{N} .+_-]+$/u.test(candidate)
    ? candidate
    : undefined;
};

const balance = (value: unknown) => {
  const candidate = text(value);
  return candidate &&
    candidate.length <= 40 &&
    /^\d+(?:\.\d+)?$/.test(candidate)
    ? candidate
    : undefined;
};

function windowLabel(minutes: number | undefined) {
  if (minutes === undefined) return "Limit";
  if (minutes < 60) return `${minutes}m limit`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h limit`;
  if (minutes < 10080) return `${Math.round(minutes / 1440)}d limit`;
  return "Weekly limit";
}

/** Sanitizes Codex app-server account and rate-limit answers. Only allowlisted
 * display facts survive; provider account and reset-credit identifiers do not. */
export function codexLiveUsage(
  accountAnswer: unknown,
  rateLimitAnswer: unknown,
  observedAt = Date.now(),
): ProviderUsageSnapshot {
  const account = object(object(accountAnswer)?.account);
  const type = text(account?.type);
  const planName = type === "chatgpt" ? plan(account?.planType) : undefined;
  const accountState = account
    ? ({
        state: "signed-in" as const,
        ...(planName ? { plan: planName } : {}),
      } as const)
    : ({ state: "signed-out" as const } as const);
  const surface =
    type === "chatgpt"
      ? "chatgpt-subscription"
      : type === "apiKey"
        ? "api"
        : "unknown";

  const answer = object(rateLimitAnswer);
  const flat = object(answer?.rateLimits) ?? {};
  const byId = object(answer?.rateLimitsByLimitId);
  const buckets: Json[] = byId
    ? Object.values(byId).flatMap((value) => {
        const bucket = object(value);
        return bucket ? [bucket] : [];
      })
    : flat.primary || flat.secondary
      ? [flat]
      : [];
  const allowances = buckets.flatMap((bucket, bucketIndex) =>
    (["primary", "secondary"] as const).flatMap((kind) => {
      const raw = object(bucket[kind]);
      if (!raw) return [];
      const usedPercent = usagePercent(raw.usedPercent);
      const windowMinutes = usageCount(raw.windowDurationMins);
      const seconds = usageCount(raw.resetsAt);
      const resetsAt = seconds === undefined ? undefined : seconds * 1000;
      if (
        usedPercent === undefined &&
        windowMinutes === undefined &&
        resetsAt === undefined
      )
        return [];
      return [
        {
          id: `${bucketIndex}-${kind}`,
          label: windowLabel(windowMinutes),
          ...(usedPercent !== undefined ? { usedPercent } : {}),
          ...(windowMinutes !== undefined ? { windowMinutes } : {}),
          ...(resetsAt !== undefined ? { resetsAt } : {}),
        },
      ];
    }),
  );
  const credit = buckets.map((bucket) => object(bucket.credits)).find(Boolean);
  const creditBalance = balance(credit?.balance);
  const unlimited = credit?.unlimited === true;
  const credits =
    creditBalance !== undefined || unlimited
      ? {
          ...(creditBalance !== undefined ? { balance: creditBalance } : {}),
          ...(unlimited ? { unlimited: true } : {}),
        }
      : undefined;
  return {
    provider: "OpenAI",
    surface,
    observedAt,
    freshness: rateLimitAnswer === undefined ? "unavailable" : "live",
    account: accountState,
    allowances,
    ...(credits ? { credits } : {}),
    ...(rateLimitAnswer === undefined
      ? { reason: "Allowance unavailable." }
      : {}),
  };
}

/** Reads account and allowance state without starting a model turn. */
export function readCodexLiveUsage(spawn: Spawn, signal: AbortSignal) {
  return withServer(spawn, signal, async (rpc) => {
    const account = await rpc.request("account/read", { refreshToken: false });
    const limits = await rpc
      .request("account/rateLimits/read")
      .catch((error) => {
        // Older servers can refuse an unknown method. A transport failure is
        // different: reject so the accessory keeps its last good snapshot.
        if (error instanceof Refused) return undefined;
        throw error;
      });
    return codexLiveUsage(account, limits);
  });
}
