import { afterEach, expect, it, vi } from "vitest";
import { createTyping } from "./typing";
import { keypair, message, signed } from "./testing";

const agent = keypair(),
  viewer = keypair();
const epoch = 1_800_000_000;
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(epoch * 1000);
  const owner = createTyping(
    viewer.pubkey,
    (id) => id === "a",
    (fn) => fn(),
  );
  return { owner, snapshot: owner.capability.snapshot };
}
function pulse(tags = [["h", "a"]], at = epoch, key = agent) {
  return signed(key, { kind: 20002, content: "", tags, created_at: at });
}
afterEach(() => vi.useRealTimers());
it("expires at signed time, ignores duplicates/out-of-order pulses and uses one timer", () => {
  const { owner, snapshot } = setup();
  owner.accept([pulse()], true);
  expect(snapshot()).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(3000);
  owner.accept([pulse(), pulse(undefined, epoch - 1)], true);
  vi.advanceTimersByTime(4999);
  expect(snapshot()).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(snapshot()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects finite, expired, future, self, denied and malformed channel/thread scope", () => {
  const { owner, snapshot } = setup();
  owner.accept([pulse()]);
  owner.accept(
    [
      pulse(undefined, epoch - 8),
      pulse(undefined, epoch + 1),
      pulse(undefined, epoch, viewer),
      pulse([]),
      pulse([["h", "denied"]]),
      pulse([
        ["h", "a"],
        ["h", "a"],
      ]),
      pulse([
        ["h", "a"],
        ["e", "bad", "", "reply"],
      ]),
      pulse([
        ["h", "a"],
        ["e", "a".repeat(64), "", "root"],
      ]),
      pulse([
        ["h", "a"],
        ["e", "a".repeat(64)],
      ]),
    ],
    true,
  );
  expect(snapshot()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it("separates channel, canonical threads, nested roots and multiple signers", () => {
  const { owner, snapshot } = setup();
  const root = "a".repeat(64),
    parent = "b".repeat(64);
  owner.accept(
    [
      pulse(),
      pulse([
        ["h", "a"],
        ["e", root, "", "reply"],
      ]),
      pulse(undefined, epoch, keypair()),
    ],
    true,
  );
  expect(snapshot()).toHaveLength(3);
  owner.accept(
    [
      pulse([
        ["h", "a"],
        ["e", root, "", "root"],
        ["e", parent, "", "reply"],
      ]),
    ],
    true,
  );
  expect(snapshot()).toHaveLength(3);
  expect(snapshot().filter((e) => e.threadRootId === root)).toHaveLength(1);
  owner.dispose();
  expect(snapshot()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it("messages win a batch, suppress late pulses for two seconds and retain timestamp watermarks", () => {
  const { owner, snapshot } = setup();
  owner.accept([pulse(), message(agent, "a", "fixture", epoch)], true);
  expect(snapshot()).toEqual([]);
  vi.advanceTimersByTime(1000);
  owner.accept([pulse(undefined, epoch + 1)], true);
  expect(snapshot()).toEqual([]);
  vi.advanceTimersByTime(1000);
  owner.accept([pulse(), pulse(undefined, epoch + 2)], true);
  expect(snapshot()).toHaveLength(1);
  // Duplicate history cannot extend suppression or remove newer activity.
  owner.accept([message(agent, "a", "old", epoch)]);
  expect(snapshot()).toHaveLength(1);
  vi.advanceTimersByTime(8000);
  expect(snapshot()).toEqual([]);
});
it("message suppression is signer/thread scoped and clears only older activity", () => {
  const { owner, snapshot } = setup();
  const tags = [
    ["h", "a"],
    ["e", "a".repeat(64), "", "reply"],
  ];
  owner.accept([pulse(), pulse(tags)], true);
  owner.accept([message(agent, "a", "channel", epoch)]);
  expect(snapshot()).toHaveLength(1);
  expect(snapshot()[0]?.threadRootId).toBe("a".repeat(64));
  owner.accept([
    signed(agent, { kind: 40002, tags, content: "{}", created_at: epoch }),
  ]);
  expect(snapshot()).toEqual([]);
});
it("bounds active and suppression records without eviction; teardown fences retained callbacks", () => {
  const { owner, snapshot } = setup();
  // Distinct roots avoid generating 1025 signing keys.
  owner.accept(
    Array.from({ length: 1025 }, (_, i) =>
      pulse([
        ["h", "a"],
        ["e", i.toString(16).padStart(64, "0"), "", "reply"],
      ]),
    ),
    true,
  );
  expect(snapshot()).toHaveLength(1024);
  expect(vi.getTimerCount()).toBe(1);
  const listener = vi.fn();
  const stop = owner.capability.subscribe(listener);
  owner.clear();
  expect(snapshot()).toEqual([]);
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
  owner.accept([pulse()], true);
  expect(listener).toHaveBeenCalledTimes(1);
  owner.dispose();
  owner.accept([pulse()], true);
  expect(snapshot()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
