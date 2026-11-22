import { expect, it } from "vitest";
import { claudeLiveUsage } from "./live-usage";

it.each([
  ["ready", "signed-in"],
  ["signed-out", "signed-out"],
  ["missing", "unknown"],
] as const)("maps %s readiness without inventing a plan", (state, account) => {
  const snapshot = claudeLiveUsage(
    {
      status: { state },
      models: [],
      modelsChecking: false,
      modelsError: "",
      checking: false,
      running: undefined,
      output: "",
      notice: undefined,
    } as never,
    42,
  );
  expect(snapshot).toEqual({
    provider: "Claude",
    surface: "unknown",
    observedAt: 42,
    freshness: "unavailable",
    account: { state: account },
    allowances: [],
    reason: "Claude does not expose structured subscription allowance data.",
  });
  expect(JSON.stringify(snapshot)).not.toContain("plan");
});
