import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPresencePublisher,
  type PresencePublisherLock,
} from "./publisher";
import type { ActivitySnapshot, PresenceActivity } from "./activity";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
});
afterEach(() => vi.useRealTimers());
function activity() {
  let value: ActivitySnapshot = { status: "online", visible: true };
  const listeners = new Set<() => void>();
  return {
    source: {
      snapshot: () => value,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } satisfies PresenceActivity,
    update(next: ActivitySnapshot) {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}
it("publishes initial/changed availability and slow renewals, never on visibility alone", async () => {
  const a = activity();
  const publish = vi.fn(
    async (_status: "online" | "away", _signal: AbortSignal) => {},
  );
  const owner = createPresencePublisher({
    activity: a.source,
    publish,
    random: () => 0,
  });
  owner.connection(true);
  await vi.advanceTimersByTimeAsync(250);
  expect(publish).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 100; i++)
    a.update({ status: "online", visible: i % 2 === 0 });
  await vi.advanceTimersByTimeAsync(59000);
  expect(publish).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(publish).toHaveBeenCalledTimes(2);
  a.update({ status: "away", visible: false });
  await vi.advanceTimersByTimeAsync(1000);
  expect(publish).toHaveBeenCalledTimes(3);
  expect(publish.mock.calls[2]?.[0]).toBe("away");
  owner.dispose();
  await vi.advanceTimersByTimeAsync(180000);
  expect(publish).toHaveBeenCalledTimes(3);
});
it("coalesces changes behind one in-flight publish and never replays missed ticks", async () => {
  const a = activity();
  const sends: { resolve(): void; signal: AbortSignal }[] = [];
  const publish = vi.fn(
    (_status: "online" | "away", signal: AbortSignal) =>
      new Promise<void>((resolve) => sends.push({ resolve, signal })),
  );
  const owner = createPresencePublisher({
    activity: a.source,
    publish,
    random: () => 0,
  });
  owner.connection(true);
  await vi.advanceTimersByTimeAsync(250);
  a.update({ status: "away", visible: true });
  await vi.advanceTimersByTimeAsync(600000);
  expect(publish).toHaveBeenCalledTimes(1);
  sends[0]?.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish.mock.calls[1]?.[0]).toBe("away");
  sends[1]?.resolve();
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(Date.now() + 3600000);
  await vi.advanceTimersByTimeAsync(60000);
  expect(publish).toHaveBeenCalledTimes(3);
  owner.dispose();
});
it("disconnect aborts old work and a late result cannot schedule work for its replacement", async () => {
  const a = activity();
  const sends: { resolve(): void; signal: AbortSignal }[] = [];
  const publish = vi.fn(
    (_status: "online" | "away", signal: AbortSignal) =>
      new Promise<void>((resolve) => sends.push({ resolve, signal })),
  );
  const owner = createPresencePublisher({
    activity: a.source,
    publish,
    random: () => 0,
  });
  owner.connection(true);
  await vi.advanceTimersByTimeAsync(250);
  owner.connection(false);
  expect(sends[0]?.signal.aborted).toBe(true);
  owner.connection(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(publish).toHaveBeenCalledTimes(2);
  sends[0]?.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(owner.diagnostics().running).toBe(true);
  sends[1]?.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(owner.diagnostics()).toMatchObject({ running: false, accepted: 1 });
  owner.dispose();
});
it("failure waits for the next renewal, rather than replaying a backlog", async () => {
  const a = activity();
  const publish = vi.fn(async () => {
    throw new Error("rate limited");
  });
  const owner = createPresencePublisher({
    activity: a.source,
    publish,
    random: () => 0,
  });
  owner.connection(true);
  await vi.advanceTimersByTimeAsync(250);
  expect(owner.diagnostics()).toMatchObject({ failures: 1, accepted: 0 });
  await vi.advanceTimersByTimeAsync(59000);
  expect(publish).toHaveBeenCalledTimes(1);
  owner.dispose();
});
it("one scoped lifetime lock prevents duplicate publishers and passes ownership after disposal", async () => {
  const waiting: (() => void)[] = [];
  let locked = false;
  const lock: PresencePublisherLock = async (signal, work) => {
    if (locked) await new Promise<void>((resolve) => waiting.push(resolve));
    if (signal.aborted) return;
    locked = true;
    try {
      await work();
    } finally {
      locked = false;
      waiting.shift()?.();
    }
  };
  const a = activity();
  const publish = vi.fn(
    async (_status: "online" | "away", _signal: AbortSignal) => {},
  );
  const first = createPresencePublisher({
    activity: a.source,
    publish,
    lock,
    random: () => 0,
  });
  const second = createPresencePublisher({
    activity: a.source,
    publish,
    lock,
    random: () => 0,
  });
  first.connection(true);
  second.connection(true);
  await vi.advanceTimersByTimeAsync(250);
  expect(publish).toHaveBeenCalledTimes(1);
  first.dispose();
  await vi.advanceTimersByTimeAsync(250);
  expect(publish).toHaveBeenCalledTimes(2);
  second.dispose();
});
it("failed lock acquisition does not silently switch to uncoordinated publishing", async () => {
  const a = activity();
  const publish = vi.fn(
    async (_status: "online" | "away", _signal: AbortSignal) => {},
  );
  const owner = createPresencePublisher({
    activity: a.source,
    publish,
    lock: async () => {
      throw new Error("lock unavailable");
    },
  });
  owner.connection(true);
  await vi.advanceTimersByTimeAsync(60000);
  expect(publish).not.toHaveBeenCalled();
  expect(owner.diagnostics().error).toBe("lock unavailable");
  owner.dispose();
});
