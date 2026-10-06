import { expect, it, vi } from "vitest";
import { createInviteIntent } from "./invite-intent";

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
