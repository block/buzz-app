import { expect, it, vi } from "vitest";
import { createInviteIntent } from "./invite-intent";

it("offers an invite to first run's current answer, and tells the owner when one registers", () => {
  const { firstRun, snapshot } = createInviteIntent();
  const invite = { community: "https://relay.example", code: "x" };
  const registered = vi.fn();
  const stop = firstRun.subscribe(registered);
  // No first run to ask: the invite stays with whoever holds it.
  expect(firstRun.offer(invite)).toBe(false);
  const decline = vi.fn(() => false);
  const release = firstRun.handle(decline);
  expect(registered).toHaveBeenCalledTimes(1);
  expect(firstRun.offer(invite)).toBe(false);
  expect(decline).toHaveBeenCalledWith(invite);
  const take = vi.fn(() => true);
  const releaseTake = firstRun.handle(take);
  expect(registered).toHaveBeenCalledTimes(2);
  // A replaced answer's cleanup cannot remove the one that replaced it.
  release();
  expect(firstRun.offer(invite)).toBe(true);
  expect(decline).toHaveBeenCalledTimes(1);
  // Taking an invite opens nothing for the join dialog.
  expect(snapshot()).toBeUndefined();
  releaseTake();
  expect(firstRun.offer(invite)).toBe(false);
  expect(take).toHaveBeenCalledTimes(1);
  stop();
});

it("keeps the latest arrival and cannot clear a newer invite from a stale dialog", () => {
  const intents = createInviteIntent();
  const listener = vi.fn();
  const stop = intents.subscribe(listener);
  const invite = { community: "https://relay.example", code: "x" };
  intents.open(invite, "alice");
  const old = intents.snapshot();
  intents.open(invite, "alice");
  expect(intents.snapshot()?.requestId).not.toBe(old?.requestId);
  intents.clear(old?.requestId);
  expect(intents.snapshot()?.code).toBe("x");
  intents.clear(intents.snapshot()?.requestId);
  expect(intents.snapshot()).toBeUndefined();
  expect(listener).toHaveBeenCalledTimes(3);
  stop();
});
