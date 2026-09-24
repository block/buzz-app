// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreditsSandbox } from "./CreditsSandbox";
import "@testing-library/jest-dom/vitest";

const nativeInvoke = vi.hoisted(() => vi.fn());
const nativeCheck = vi.hoisted(() => vi.fn(() => false));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: nativeInvoke,
  isTauri: nativeCheck,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  nativeInvoke.mockReset();
  nativeCheck.mockReset();
  nativeCheck.mockReturnValue(false);
});

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

it("simulates earning, spending, and resetting a local demo ledger", () => {
  render(<CreditsSandbox />);
  expect(screen.getByText("0 credits")).toBeInTheDocument();
  expect(
    screen.getByText(/not connected to compute or a wallet/i),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Add 10 demo credits" }));
  expect(screen.getByText("10 credits")).toBeInTheDocument();
  expect(
    screen.getByText("Simulated serving · 10,000 tokens"),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Spend demo credits" }));
  expect(screen.getByText("8 credits")).toBeInTheDocument();
  expect(screen.getByText("Simulated spend")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Reset demo" }));
  expect(screen.getByText("0 credits")).toBeInTheDocument();
  expect(
    screen.getByText(
      "No demo entries yet. Add credits or serve compute to try the ledger.",
    ),
  ).toBeInTheDocument();
});

it("shows only the Consumer's balance and transfers a demo spend", async () => {
  nativeCheck.mockReturnValue(true);
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === "community_compute_demo_wallet")
      return {
        role: "consumer",
        ledger: {
          consumerBalance: 10,
          providerBalance: 2,
          tokensServed: 2_000,
          entries: [],
        },
      };
    if (command === "community_compute_demo_seed_legacy")
      return {
        consumerBalance: 10,
        providerBalance: 2,
        tokensServed: 2_000,
        entries: [],
      };
    if (command === "community_compute_demo_spend")
      return {
        consumerBalance: 8,
        providerBalance: 4,
        tokensServed: 2_000,
        entries: [],
      };
    throw new Error(`Unexpected command ${command}`);
  });

  render(<CreditsSandbox />);
  await waitFor(() =>
    expect(screen.getByText("Consumer demo balance")).toBeInTheDocument(),
  );
  expect(screen.getByText("10 credits")).toBeInTheDocument();
  expect(screen.queryByText("Provider demo balance")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Spend demo credits" }));
  await waitFor(() =>
    expect(nativeInvoke).toHaveBeenCalledWith("community_compute_demo_spend", {
      amount: 2,
    }),
  );
});

it("shows only the Provider's balance and provider-side ledger entries", async () => {
  nativeCheck.mockReturnValue(true);
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === "community_compute_demo_wallet")
      return {
        role: "provider",
        ledger: {
          consumerBalance: 10,
          providerBalance: 2,
          tokensServed: 2_000,
          entries: [
            {
              id: "serve",
              kind: "served-tokens",
              consumerDelta: -2,
              providerDelta: 2,
              tokens: 2_000,
              createdAt: 1,
            },
            {
              id: "top-up",
              kind: "demo-top-up",
              consumerDelta: 10,
              providerDelta: 0,
              tokens: 0,
              createdAt: 2,
            },
          ],
        },
      };
    throw new Error(`Unexpected command ${command}`);
  });

  render(<CreditsSandbox />);
  await waitFor(() =>
    expect(screen.getByText("Provider demo balance")).toBeInTheDocument(),
  );
  expect(screen.getByText("2 credits")).toBeInTheDocument();
  expect(screen.queryByText("Consumer demo balance")).not.toBeInTheDocument();
  expect(screen.queryByText("10 credits")).not.toBeInTheDocument();
  expect(
    screen.getByText("Simulated serving · 2,000 tokens"),
  ).toBeInTheDocument();
  expect(screen.queryByText("Demo credit top-up")).not.toBeInTheDocument();
});
