import { afterEach, expect, it, vi } from "vitest";
import { messageActionRequests } from "./action-requests";

const session = {} as import("../relay/session").RelaySession;
const request = {
  session,
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
  const take = (s = session, scope = request.scope, id = "m1") =>
    messageActionRequests.take(s, scope, "channel", id);
  expect(take(session, "other")).toBeUndefined();
  expect(take(session, request.scope, "m2")).toBeUndefined();
  // Another session for the same scope is not the one the handoff came from.
  expect(take({} as typeof session)).toBeUndefined();
  expect(take()).toEqual(request);
  expect(take()).toBeUndefined();
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
