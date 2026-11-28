import { expect, it, vi } from "vitest";
import type { OpenTarget } from "../../../features/navigation/targets";
import { startConnectionAlerts } from "./alerts";
import type { Connection } from "./client";
import { memoryStorage } from "../../../features/agents/test-fakes";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const target: OpenTarget = { version: 1, kind: "settings" };

function fakeStore(connections: readonly Connection[]) {
  let state = { connections, loading: false };
  const listeners = new Set<() => void>();
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh: vi.fn(async () => {}),
    set(next: readonly Connection[]) {
      state = { connections: next, loading: false };
      for (const listener of listeners) listener();
    },
  };
}

function start(store: ReturnType<typeof fakeStore>, storage: Storage) {
  const submit = vi.fn(async () => true);
  const stop = startConnectionAlerts({
    store,
    submit,
    target,
    storage,
    now: () => NOW,
  });
  return { submit, stop };
}

it("alerts once as a connection nears its end and once when it ends, across restarts", () => {
  const storage = memoryStorage();
  const expiring: Connection = {
    name: "google-calendar",
    expiresAt: NOW + 2 * DAY + 1,
    expired: false,
  };
  const store = fakeStore([
    expiring,
    { name: "slack", expired: false },
    { name: "datadog", expiresAt: NOW + 30 * DAY, expired: false },
  ]);
  const first = start(store, storage);
  expect(first.submit).toHaveBeenCalledTimes(1);
  expect(first.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      target,
      title: "Google Calendar connection expires in 2 days",
    }),
  );
  store.set([...store.snapshot().connections]);
  expect(first.submit).toHaveBeenCalledTimes(1);
  first.stop();

  const restarted = start(store, storage);
  expect(restarted.submit).not.toHaveBeenCalled();
  store.set([{ name: "google-calendar", expired: true }]);
  expect(restarted.submit).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Google Calendar connection expired" }),
  );
  restarted.stop();
});

it("re-reads the list hourly until stopped", () => {
  vi.useFakeTimers();
  try {
    const store = fakeStore([]);
    const { stop } = start(store, memoryStorage());
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(store.refresh).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(store.refresh).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
