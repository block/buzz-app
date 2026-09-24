import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUserStatuses } from "./user-status";
import { keypair, signed } from "./testing";
import type { RelayEvent } from "./events";
import type { RelayReader } from "./reader";

const alice = keypair();
const bob = keypair();
const now = 1_700_000_000;
function status(text: string, emoji = "", time = now, expiresAt?: number) {
  return signed(alice, {
    kind: 30315,
    created_at: time,
    content: text,
    tags: [
      ["d", "general"],
      ...(emoji ? [["emoji", emoji]] : []),
      ...(expiresAt === undefined ? [] : [["expiration", String(expiresAt)]]),
    ],
  });
}
const owners: ReturnType<typeof createUserStatuses>[] = [];
function setup(
  reader: RelayReader = { read: async () => [] },
  publish = vi.fn(async (_event: RelayEvent, _signal: AbortSignal) => {}),
) {
  const sign = vi.fn(async (template) => signed(alice, template));
  const owner = createUserStatuses(reader, alice.pubkey, {
    kinds: [30315],
    sign,
    publish,
  });
  owners.push(owner);
  owner.queries.watch([alice.pubkey]);
  return { owner, queries: owner.queries, sign, publish };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now * 1000);
});
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});

it("shares emoji-only and text-only values and preserves text when the emoji is removed", () => {
  const { owner, queries } = setup();
  const changed = vi.fn();
  queries.subscribe(changed);
  owner.accept([status("", "🚌")]);
  expect(queries.snapshot().get(alice.pubkey)).toMatchObject({
    text: "",
    emoji: "🚌",
  });
  owner.accept([status("Commuting", "🚌", now + 1)]);
  owner.accept([status("Commuting", "", now + 2)]);
  expect(queries.snapshot().get(alice.pubkey)).toMatchObject({
    text: "Commuting",
    emoji: "",
  });
  expect(changed).toHaveBeenCalledTimes(3);
});

it("keeps explicit clears as replacement evidence against stale reads and live replay", () => {
  const { owner, queries } = setup();
  owner.accept([status("Working", "🏠"), status("", "", now + 2)]);
  owner.accept([status("Late old update", "", now + 1)]);
  expect(queries.snapshot().size).toBe(0);
  owner.accept([status("New", "", now + 3)]);
  expect(queries.snapshot().get(alice.pubkey)?.text).toBe("New");
});

it("expires at the deadline, keeps the expired replacement, and filters it after restart", async () => {
  const event = status("Meeting", "🗣️", now, now + 3600);
  const { owner, queries } = setup();
  owner.accept([event]);
  const changed = vi.fn();
  queries.subscribe(changed);
  await vi.advanceTimersByTimeAsync(3599999);
  expect(queries.snapshot().size).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(queries.snapshot().size).toBe(0);
  expect(changed).toHaveBeenCalledOnce();
  owner.accept([status("Old", "", now - 1)]);
  expect(queries.snapshot().size).toBe(0);
  const restarted = setup({ read: async () => [event] });
  await vi.runAllTimersAsync();
  expect(restarted.queries.snapshot().size).toBe(0);
});

it("uses deterministic ID ordering for events in the same second", () => {
  const first = status("first"),
    second = status("second");
  const a = setup(),
    b = setup();
  a.owner.accept([first, second]);
  b.owner.accept([second, first]);
  expect(a.queries.snapshot().get(alice.pubkey)).toEqual(
    b.queries.snapshot().get(alice.pubkey),
  );
});

it("batches mounted people, refreshes after reconnect, and a late read cannot replace a live clear", async () => {
  let resolve!: (events: RelayEvent[]) => void;
  const read = vi.fn<RelayReader["read"]>(
    () =>
      new Promise<RelayEvent[]>((done) => {
        resolve = done;
      }),
  );
  const { owner, queries } = setup({ read });
  queries.watch([bob.pubkey]);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]?.[0][0]?.authors).toEqual([
    alice.pubkey,
    bob.pubkey,
  ]);
  owner.accept([status("", "", now + 1)]);
  resolve([status("Stale")]);
  await vi.advanceTimersByTimeAsync(0);
  expect(queries.snapshot().size).toBe(0);
  owner.reconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  resolve([status("Fresh", "", now + 2)]);
  await vi.advanceTimersByTimeAsync(0);
  expect(queries.snapshot().get(alice.pubkey)?.text).toBe("Fresh");
});

it("waits for publication and keeps the previous status on rejection", async () => {
  let finish!: () => void;
  const publish = vi.fn(
    (_event: RelayEvent, _signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { owner, queries } = setup(undefined, publish);
  owner.accept([status("Before")]);
  let done = false;
  const saving = queries
    .save({ text: "After", emoji: ":party:", expiresAt: now + 86400 })
    .then(() => {
      done = true;
    });
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toBe(false);
  expect(queries.snapshot().get(alice.pubkey)?.text).toBe("Before");
  finish();
  await saving;
  expect(queries.snapshot().get(alice.pubkey)).toMatchObject({
    text: "After",
    emoji: ":party:",
    expiresAt: now + 86400,
  });
  publish.mockRejectedValueOnce(new Error("Relay refused"));
  await expect(queries.save({ text: "", emoji: "" })).rejects.toThrow(
    "Relay refused",
  );
  expect(queries.snapshot().get(alice.pubkey)?.text).toBe("After");
});

it("publishes a durable clear and advances the timestamp beyond the current own status", async () => {
  const { queries, publish } = setup({
    read: async () => [status("Before", "🚌", now, now + 600)],
  });
  await queries.save({ text: "", emoji: "" });
  expect(publish.mock.calls[0]?.[0]).toMatchObject({
    kind: 30315,
    created_at: now + 1,
    content: "",
    tags: [["d", "general"]],
  });
  expect(queries.snapshot().size).toBe(0);
});

it("isolates communities and refuses malformed coordinates and past expiration", async () => {
  const a = setup(),
    b = setup();
  a.owner.accept([status("Only A")]);
  expect(b.queries.snapshot().size).toBe(0);
  a.owner.accept([
    signed(alice, {
      kind: 30315,
      created_at: now + 2,
      content: "Wrong coordinate",
      tags: [["d", "music"]],
    }),
  ]);
  expect(a.queries.snapshot().get(alice.pubkey)?.text).toBe("Only A");
  await expect(
    a.queries.save({ text: "Expired", emoji: "", expiresAt: now - 1 }),
  ).rejects.toThrow("future");
  expect(a.sign).not.toHaveBeenCalled();
});

it("disposal fences late reads, late publications, and expiration notifications", async () => {
  let finish!: () => void;
  const publish = vi.fn(
    (_event: RelayEvent, _signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { owner, queries } = setup(undefined, publish);
  const saving = queries.save({ text: "Late", emoji: "" });
  const rejected = expect(saving).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  owner.dispose();
  finish();
  await rejected;
  expect(queries.snapshot().size).toBe(0);
});
