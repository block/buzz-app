import { afterEach, expect, it, vi } from "vitest";
import { messageActionRequests } from "./action-requests";

const request = {
  scope: "wss://relay:viewer",
  channelId: "channel",
  messageId: "m1",
  key: "plugin:remind",
  revision: "1",
};
afterEach(() => {
  messageActionRequests.clear();
  vi.useRealTimers();
});

it("is taken only by the row showing that message in that connection, once", () => {
  const seen = vi.fn();
  const stop = messageActionRequests.subscribe(seen);
  messageActionRequests.request(request);
  expect(seen).toHaveBeenCalledTimes(1);
  expect(messageActionRequests.take("other", "channel", "m1")).toBeUndefined();
  expect(
    messageActionRequests.take(request.scope, "channel", "m2"),
  ).toBeUndefined();
  expect(messageActionRequests.take(request.scope, "channel", "m1")).toEqual(
    request,
  );
  expect(
    messageActionRequests.take(request.scope, "channel", "m1"),
  ).toBeUndefined();
  expect(messageActionRequests.snapshot()).toBeUndefined();
  stop();
});

it("expires an unconsumed request and keeps only the latest", () => {
  vi.useFakeTimers();
  messageActionRequests.request(request);
  messageActionRequests.request({ ...request, messageId: "m2" });
  expect(messageActionRequests.snapshot()?.messageId).toBe("m2");
  vi.advanceTimersByTime(15_001);
  expect(messageActionRequests.snapshot()).toBeUndefined();
});
