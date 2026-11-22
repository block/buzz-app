// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderUsageSnapshot } from "../../features/agents/live-usage";
import {
  allowanceRemaining,
  resetLabel,
  UsageMeterView,
} from "./UsageMeterAccessory";

afterEach(cleanup);

const provider: ProviderUsageSnapshot = {
  provider: "OpenAI",
  surface: "chatgpt-subscription",
  observedAt: Date.now(),
  freshness: "live",
  account: { state: "signed-in", plan: "Plus" },
  allowances: [
    {
      id: "primary",
      label: "5h limit",
      usedPercent: 25,
      resetsAt: Date.now() + 60 * 60 * 1000,
    },
  ],
  credits: { balance: "12.5" },
};

it("shows compact context and allowance values, then expands details", () => {
  const refresh = vi.fn();
  render(
    <UsageMeterView
      agentName="Chat GPT"
      provider={provider}
      run={{ contextUsed: 50_000, contextSize: 200_000 }}
      failed={false}
      loading={false}
      onRefresh={refresh}
    />,
  );
  expect(screen.getByText("25% context")).toBeInTheDocument();
  expect(screen.getByText("75% remaining")).toBeInTheDocument();
  expect(screen.getAllByText("Plus")).toHaveLength(2);
  expect(
    screen.getByRole("progressbar", { name: "Context used" }),
  ).toHaveAttribute("aria-valuenow", "25");
  fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect(refresh).toHaveBeenCalledOnce();
});

it("keeps zero as a real allowance observation", () => {
  expect(allowanceRemaining({ id: "a", label: "limit", usedPercent: 0 })).toBe(
    100,
  );
  expect(allowanceRemaining({ id: "a", label: "limit" })).toBeUndefined();
});

it("formats future and passed resets without exposing an opaque timestamp", () => {
  const now = 1_000_000;
  expect(resetLabel(now + 61 * 60_000, now)).toBe("resets in 2h");
  expect(resetLabel(now - 1, now)).toBe("reset due");
});
