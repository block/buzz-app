import { expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type { LocalWork } from "../agents/local-activity";
import { followUpQueue } from "./follow-up-queue";

function fixture() {
  const listeners = new Set<() => void>();
  let local: readonly LocalWork[] = [];
  let turns: ReturnType<RelaySession["agentActivity"]["snapshot"]>["turns"] =
    [];
  const session = {
    agentActivity: {
      activate: () => () => {},
      snapshot: () => ({ local, turns }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  const queue = followUpQueue(session);
  return {
    queue,
    session,
    work(messageId: string, state: LocalWork["state"], channelId = "chat") {
      local = [
        ...local.filter((row) => row.messageId !== messageId),
        {
          messageId,
          state,
          channelId,
          agent: "agent",
          scope: "scope",
          threadRootId: "",
          startedAt: 1,
        },
      ];
      for (const listener of listeners) listener();
    },
    remote(state: "working" | "unknown" | "ended") {
      turns = [
        {
          agent: "agent",
          channelId: "chat",
          turnId: "turn",
          timestamp: 1,
          state,
        },
      ];
      for (const listener of listeners) listener();
    },
    loseEvidence() {
      local = [];
      turns = [];
      for (const listener of listeners) listener();
    },
    entry(text: string, channelId = "chat") {
      return {
        text,
        channelId,
        recipients: ["agent"],
        publish: vi.fn(() => text),
      };
    },
  };
}

it("sends idle messages immediately and holds rapid follow-ups through the start gap", () => {
  const h = fixture(),
    first = h.entry("first"),
    second = h.entry("second"),
    third = h.entry("third");
  expect(h.queue.submit(first)).toBe("first");
  h.queue.submit(second);
  h.queue.submit(third);
  expect(second.publish).not.toHaveBeenCalled();
  h.work("first", "working");
  h.work("first", "done");
  expect(second.publish).toHaveBeenCalledOnce();
  expect(third.publish).not.toHaveBeenCalled();
  h.work("second", "working");
  h.work("second", "done");
  expect(third.publish).toHaveBeenCalledOnce();
  expect(h.queue.snapshot()).toEqual([]);
});

it("waits for existing work, survives lost evidence, and permits Send now", () => {
  const h = fixture(),
    entry = h.entry("next");
  h.work("previous", "working");
  h.queue.submit(entry);
  h.loseEvidence();
  expect(entry.publish).not.toHaveBeenCalled();
  h.queue.sendNow(h.queue.snapshot()[0]?.id ?? "missing");
  expect(entry.publish).toHaveBeenCalledOnce();
  h.work("previous", "done");
  expect(entry.publish).toHaveBeenCalledOnce();
});

it("uses explicit remote completion, never a stale unknown state", () => {
  const h = fixture(),
    entry = h.entry("next");
  h.remote("working");
  h.queue.submit(entry);
  h.remote("unknown");
  expect(entry.publish).not.toHaveBeenCalled();
  h.remote("ended");
  expect(entry.publish).toHaveBeenCalledOnce();
});

it("retains failed sends for explicit retry without a retry loop", () => {
  const h = fixture(),
    entry = h.entry("next");
  entry.publish.mockImplementationOnce(() => {
    throw new Error("Unavailable recipient");
  });
  h.work("previous", "working");
  h.queue.submit(entry);
  h.work("previous", "done");
  expect(h.queue.snapshot()[0]?.error).toBe("Unavailable recipient");
  h.work("unrelated", "done", "other");
  expect(entry.publish).toHaveBeenCalledOnce();
  h.queue.sendNow(h.queue.snapshot()[0]?.id ?? "missing");
  expect(entry.publish).toHaveBeenCalledTimes(2);
  expect(h.queue.snapshot()).toEqual([]);
});

it("isolates channels and sessions, and removal never publishes", () => {
  const h = fixture(),
    entry = h.entry("next");
  h.work("previous", "working");
  h.queue.submit(entry);
  expect(h.queue.submit(h.entry("elsewhere", "other"))).toBe("elsewhere");
  expect(followUpQueue(h.session)).toBe(h.queue);
  expect(fixture().queue.snapshot()).toEqual([]);
  h.queue.remove(h.queue.snapshot()[0]?.id ?? "missing");
  h.work("previous", "done");
  expect(entry.publish).not.toHaveBeenCalled();
});
