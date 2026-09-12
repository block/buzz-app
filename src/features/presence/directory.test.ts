import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPresenceDirectory, parsePresenceStatus } from "./directory";
import { keypair, signed } from "../relay/testing";
import type { RelayEvent } from "../relay/events";
import type { RelayReader } from "../relay/reader";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
});
afterEach(() => vi.useRealTimers());
function setup() {
  const relay = keypair();
  const user = keypair();
  const updates = vi.fn();
  const reads: {
    resolve(events: RelayEvent[]): void;
    reject(error: Error): void;
    signal?: AbortSignal;
  }[] = [];
  const read = vi.fn<RelayReader["read"]>(
    (_filters, options) =>
      new Promise((resolve, reject) =>
        reads.push({
          resolve,
          reject,
          ...(options?.signal ? { signal: options.signal } : {}),
        }),
      ),
  );
  const owner = createPresenceDirectory({
    reader: { read },
    relayAuthor: relay.pubkey,
    updateInterests: updates,
    supported: true,
    random: () => 0,
  });
  const demand = owner.queries.demand();
  owner.connection(true);
  const mount = (authors = [user.pubkey]) => {
    demand.update(authors);
    owner.route({ status: "ready", authors });
  };
  const snapshot = (status = "online", who = user.pubkey) =>
    signed(relay, { kind: 20001, content: status, tags: [["p", who]] });
  const live = (status = "online", time = 1) =>
    signed(user, { kind: 20001, content: status, tags: [], created_at: time });
  return {
    owner,
    demand,
    user,
    relay,
    reads,
    read,
    updates,
    mount,
    snapshot,
    live,
  };
}
it("one surface deduplicates 1000 avatars, shares a background snapshot and stops on empty demand", async () => {
  const s = setup();
  const authors = Array.from({ length: 20 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  s.mount(Array.from({ length: 1000 }, (_, i) => authors[i % 20] ?? ""));
  await vi.advanceTimersByTimeAsync(100);
  expect(s.read).toHaveBeenCalledTimes(1);
  expect(s.read.mock.calls[0]?.[0]).toEqual([
    { kinds: [20001], authors, limit: 20 },
  ]);
  expect(s.read.mock.calls[0]?.[1]?.priority).toBe("background");
  expect(s.owner.diagnostics()).toMatchObject({ authors: 20, handles: 1 });
  s.reads[0]?.resolve([]);
  await vi.advanceTimersByTimeAsync(0);
  s.demand.dispose();
  expect(s.updates).toHaveBeenLastCalledWith([]);
  await vi.advanceTimersByTimeAsync(180000);
  expect(s.read).toHaveBeenCalledTimes(1);
  s.owner.dispose();
});
it("same-status renewals do not notify or poll per heartbeat; the backstop is shared", async () => {
  const s = setup();
  s.mount();
  const listener = vi.fn();
  s.owner.queries.subscribe(s.user.pubkey, listener);
  await vi.advanceTimersByTimeAsync(100);
  s.reads[0]?.resolve([s.snapshot()]);
  await vi.advanceTimersByTimeAsync(0);
  expect(listener).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 100; i++) s.owner.receive([s.live("online", i)]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(s.read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(55200);
  expect(s.read).toHaveBeenCalledTimes(2);
  expect(listener).toHaveBeenCalledTimes(1);
  s.reads[1]?.resolve([s.snapshot()]);
  await vi.advanceTimersByTimeAsync(0);
  expect(listener).toHaveBeenCalledTimes(1);
  s.owner.dispose();
});
it("offline snapshot then delayed heartbeat stays unknown until one rate-bounded confirmation", async () => {
  const s = setup();
  s.mount();
  await vi.advanceTimersByTimeAsync(100);
  s.reads[0]?.resolve([]);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.owner.queries.get(s.user.pubkey)).toBe("offline");
  for (let i = 0; i < 100; i++) s.owner.receive([s.live("online", i)]);
  expect(s.owner.queries.get(s.user.pubkey)).toBe("unknown");
  await vi.advanceTimersByTimeAsync(4999);
  expect(s.read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(s.read).toHaveBeenCalledTimes(2);
  s.reads[1]?.resolve([]);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.owner.queries.get(s.user.pubkey)).toBe("offline");
  s.owner.dispose();
});
it("conflict during snapshot, clock skew and malicious live p tags cannot supply authority", async () => {
  const s = setup();
  s.mount();
  await vi.advanceTimersByTimeAsync(100);
  s.owner.receive([s.live("away", 9000000000)]);
  s.reads[0]?.resolve([s.snapshot("online")]);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.owner.queries.get(s.user.pubkey)).toBe("unknown");
  const attacker = keypair();
  s.owner.receive([
    signed(attacker, {
      kind: 20001,
      content: "online",
      tags: [["p", s.user.pubkey]],
    }),
  ]);
  expect(s.owner.diagnostics().received).toBe(1);
  await vi.advanceTimersByTimeAsync(5000);
  s.reads[1]?.resolve([s.snapshot("away")]);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.owner.queries.get(s.user.pubkey)).toBe("away");
  s.owner.dispose();
});
it("failed or malformed snapshots are not offline and retry only on the slow budget", async () => {
  const s = setup();
  s.mount();
  await vi.advanceTimersByTimeAsync(100);
  s.reads[0]?.resolve([s.live()]);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.owner.queries.get(s.user.pubkey)).toBe("unknown");
  expect(s.owner.diagnostics().error).toContain("Invalid relay");
  await vi.advanceTimersByTimeAsync(59000);
  expect(s.read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.read).toHaveBeenCalledTimes(2);
  s.reads[1]?.reject(new Error("Redis unavailable"));
  await vi.advanceTimersByTimeAsync(0);
  expect(s.owner.queries.get(s.user.pubkey)).toBe("unknown");
  s.owner.dispose();
});
it("removed/re-added demand, hidden state, access clear and disposal fence late reads", async () => {
  const s = setup();
  s.mount();
  await vi.advanceTimersByTimeAsync(100);
  s.demand.update([]);
  s.mount();
  s.reads[0]?.resolve([s.snapshot()]);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.owner.queries.get(s.user.pubkey)).toBe("unknown");
  await vi.advanceTimersByTimeAsync(5000);
  s.owner.visibility(false);
  expect(s.updates).toHaveBeenLastCalledWith([]);
  expect(s.reads[1]?.signal?.aborted).toBe(true);
  s.reads[1]?.resolve([s.snapshot()]);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.owner.queries.get(s.user.pubkey)).toBe("unknown");
  s.owner.visibility(true);
  s.owner.route({ status: "ready", authors: [s.user.pubkey] });
  await vi.advanceTimersByTimeAsync(5000);
  s.owner.clear();
  s.reads[2]?.resolve([s.snapshot()]);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.owner.queries.get(s.user.pubkey)).toBe("unknown");
  s.owner.dispose();
  await vi.advanceTimersByTimeAsync(180000);
  expect(s.owner.diagnostics()).toMatchObject({
    authors: 0,
    handles: 0,
    pending: false,
  });
});
it("continuous changed demand still flushes and never creates concurrent reads", async () => {
  const s = setup();
  s.mount();
  for (let i = 0; i < 20; i++) {
    const authors = [s.user.pubkey, i.toString(16).padStart(64, "0")];
    s.demand.update(authors);
    s.owner.route({ status: "ready", authors });
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(s.read).toHaveBeenCalledTimes(1);
  s.reads[0]?.resolve([]);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(4100);
  expect(s.read).toHaveBeenCalledTimes(2);
  s.owner.dispose();
});
it("caps authors and surface handles without a broad fallback", () => {
  const s = setup();
  const tooMany = Array.from({ length: 257 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  expect(s.demand.update(tooMany)).toBe(false);
  expect(s.updates).toHaveBeenLastCalledWith([]);
  for (let i = 0; i < 100; i++) s.owner.queries.demand();
  expect(s.owner.diagnostics().handles).toBe(64);
  s.owner.dispose();
});
it("accepts bare statuses and legacy JSON, not arbitrary values", () => {
  for (const status of ["online", "away", "offline"]) {
    expect(parsePresenceStatus({ content: status })).toBe(status);
    expect(parsePresenceStatus({ content: JSON.stringify({ status }) })).toBe(
      status,
    );
  }
  expect(parsePresenceStatus({ content: "banana" })).toBeUndefined();
  expect(parsePresenceStatus({ content: "null" })).toBeUndefined();
});
