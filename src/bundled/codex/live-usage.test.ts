import { expect, it } from "vitest";
import { codexLiveUsage } from "./live-usage";

it("keeps zeroes and separate windows while excluding private identifiers", () => {
  const snapshot = codexLiveUsage(
    {
      account: {
        type: "chatgpt",
        planType: "Plus",
        email: "person@example.org",
        accountId: "account-secret",
      },
    },
    {
      rateLimits: {
        limitId: "opaque-bucket",
        accountUuid: "account-secret",
        resetCreditId: "credit-secret",
        primary: {
          usedPercent: 0,
          windowDurationMins: 300,
          resetsAt: 1_760_000_000,
        },
        secondary: {
          usedPercent: 11,
          windowDurationMins: 10080,
          resetsAt: 1_760_500_000,
        },
        credits: { balance: "12.5" },
      },
    },
    42,
  );
  expect(snapshot).toEqual({
    provider: "OpenAI",
    surface: "chatgpt-subscription",
    observedAt: 42,
    freshness: "live",
    account: { state: "signed-in", plan: "Plus" },
    allowances: [
      {
        id: "0-primary",
        label: "5h limit",
        usedPercent: 0,
        windowMinutes: 300,
        resetsAt: 1_760_000_000_000,
      },
      {
        id: "0-secondary",
        label: "Weekly limit",
        usedPercent: 11,
        windowMinutes: 10080,
        resetsAt: 1_760_500_000_000,
      },
    ],
    credits: { balance: "12.5" },
  });
  const encoded = JSON.stringify(snapshot);
  expect(encoded).not.toContain("person@example.org");
  expect(encoded).not.toContain("account-secret");
  expect(encoded).not.toContain("credit-secret");
  expect(encoded).not.toContain("opaque-bucket");
});

it("drops invalid numbers instead of turning unknown values into zero", () => {
  const snapshot = codexLiveUsage(
    { account: { type: "apiKey", planType: "do-not-show" } },
    {
      rateLimitsByLimitId: {
        first: {
          primary: {
            usedPercent: Number.NaN,
            windowDurationMins: -1,
            resetsAt: "later",
          },
          secondary: { usedPercent: 101 },
          credits: { balance: "credit-secret", unlimited: true },
        },
      },
    },
    43,
  );
  expect(snapshot).toEqual({
    provider: "OpenAI",
    surface: "api",
    observedAt: 43,
    freshness: "live",
    account: { state: "signed-in" },
    allowances: [],
    credits: { unlimited: true },
  });
});

it("reports signed out separately from unknown allowance data", () => {
  expect(codexLiveUsage({ account: null }, {}, 44)).toEqual({
    provider: "OpenAI",
    surface: "unknown",
    observedAt: 44,
    freshness: "live",
    account: { state: "signed-out" },
    allowances: [],
  });
});

it("keeps account state when allowance data is unavailable", () => {
  expect(
    codexLiveUsage(
      { account: { type: "chatgpt", planType: "pro" } },
      undefined,
      45,
    ),
  ).toEqual({
    provider: "OpenAI",
    surface: "chatgpt-subscription",
    observedAt: 45,
    freshness: "unavailable",
    account: { state: "signed-in", plan: "pro" },
    allowances: [],
    reason: "Allowance unavailable.",
  });
});
