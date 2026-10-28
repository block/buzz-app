// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "../../features/agents/service";
import { writeView } from "../../shared/view-state";
import { moveAgent, useAgentOrder } from "./agent-order";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("keeps the saved order after a failed save, retries, and reconciles removed agents", () => {
  const scope = "https://relay.example:owner";
  const ada = { pubkey: "1".repeat(64), name: "Ada" } as Agent;
  const bo = { pubkey: "2".repeat(64), name: "Bo" } as Agent;
  const next = { pubkey: "3".repeat(64), name: "New" } as Agent;
  writeView(scope, "agents:order", { malformed: true });
  const { result, rerender } = renderHook(
    ({ agents }) => useAgentOrder(scope, agents),
    { initialProps: { agents: [ada, bo] } },
  );
  expect(result.current.ordered).toEqual([ada, bo]);
  act(() => result.current.save([ada, bo]));
  const moved = moveAgent(result.current.ordered, 0, 1);
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
  try {
    act(() => result.current.save(moved));
    expect(result.current.error).toContain("order couldn't be saved");
    expect(result.current.ordered).toEqual([ada, bo]);
  } finally {
    storage.mockRestore();
  }
  act(() => result.current.save(moved));
  expect(result.current.error).toBe("");
  expect(result.current.ordered).toEqual([bo, ada]);
  rerender({ agents: [bo, next] });
  expect(result.current.ordered).toEqual([bo, next]);
});
