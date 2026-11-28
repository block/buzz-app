// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EventViewSnapshot, RelaySession } from "../relay/session";
import { useAgentOwnerEvidence } from "./useAgentOwnerEvidence";

afterEach(cleanup);

function observedSession() {
  let snapshot: EventViewSnapshot = { status: "idle", events: [] };
  const listeners = new Set<() => void>();
  const set = (next: EventViewSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const outcome = { failing: true };
  let reading = false;
  const view = {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(async () => {
      if (reading) return;
      reading = true;
      set({ status: "loading", events: [] });
      await Promise.resolve();
      set(
        outcome.failing
          ? { status: "error", events: [], error: "offline" }
          : { status: "ready", events: [] },
      );
      reading = false;
    }),
    dispose: vi.fn(),
  };
  const observe = vi.fn(() => view);
  const session = {
    observe,
    profiles: { subscribe: () => () => {}, event: () => undefined },
  } as unknown as RelaySession;
  return { session, view, observe, outcome };
}

const agent = "a".repeat(64);

it("refreshes a failed observation that other holders share when one retries", async () => {
  const { session, view, observe, outcome } = observedSession();
  const statuses: Record<string, string> = {};
  function Holder({ name, attempt }: { name: string; attempt: number }) {
    statuses[name] = useAgentOwnerEvidence(session, agent, attempt).status;
    return null;
  }
  const holders = (attempt: number) => (
    <>
      <Holder name="first" attempt={attempt} />
      <Holder name="second" attempt={0} />
    </>
  );
  const view_ = render(holders(0));
  await waitFor(() =>
    expect(statuses).toEqual({ first: "error", second: "error" }),
  );
  expect(observe).toHaveBeenCalledTimes(1);

  outcome.failing = false;
  await act(async () => {
    view_.rerender(holders(1));
  });
  await waitFor(() =>
    expect(statuses).toEqual({ first: "ready", second: "ready" }),
  );
  expect(observe).toHaveBeenCalledTimes(1);
  expect(view.dispose).not.toHaveBeenCalled();
});

it("keeps a failed observation failed until someone retries it", async () => {
  const { session, view } = observedSession();
  let status = "";
  function Holder() {
    status = useAgentOwnerEvidence(session, agent).status;
    return null;
  }
  render(<Holder />);
  await waitFor(() => expect(status).toBe("error"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(view.refresh).toHaveBeenCalledTimes(1);
});
