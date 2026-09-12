import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPresenceActivity } from "./activity";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("shares one detector, keeps raw input out of subscribers, and blur alone never means away", async () => {
  const doc = new EventTarget() as EventTarget & { visibilityState: string };
  doc.visibilityState = "visible";
  vi.stubGlobal("document", doc);
  const owner = createPresenceActivity();
  const listener = vi.fn();
  owner.activity.subscribe(listener);
  for (let i = 0; i < 1000; i++) doc.dispatchEvent(new Event("pointermove"));
  expect(listener).not.toHaveBeenCalled();
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(owner.activity.snapshot()).toEqual({
    status: "online",
    visible: false,
  });
  await vi.advanceTimersByTimeAsync(600000);
  expect(owner.activity.snapshot().status).toBe("away");
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(owner.activity.snapshot().status).toBe("away");
  doc.dispatchEvent(new Event("keydown"));
  expect(owner.activity.snapshot().status).toBe("online");
  const count = listener.mock.calls.length;
  owner.dispose();
  await vi.advanceTimersByTimeAsync(600000);
  doc.dispatchEvent(new Event("pointermove"));
  expect(listener).toHaveBeenCalledTimes(count);
});
