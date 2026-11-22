import type { ProviderUsageSnapshot } from "../../features/agents/live-usage";
import type { SetupState } from "./setup";

/** Claude currently exposes integration readiness but no stable structured
 * consumer-plan allowance API. Keep that distinction visible instead of
 * deriving a plan from authentication or parsing `/usage` prose. */
export function claudeLiveUsage(
  setup: SetupState,
  observedAt = Date.now(),
): ProviderUsageSnapshot {
  const state = setup.status?.state;
  const accountState =
    state === "ready"
      ? "signed-in"
      : state === "signed-out"
        ? "signed-out"
        : "unknown";
  return {
    provider: "Claude",
    surface: "unknown",
    observedAt,
    freshness: "unavailable",
    account: { state: accountState },
    allowances: [],
    reason: "Claude does not expose structured subscription allowance data.",
  };
}
