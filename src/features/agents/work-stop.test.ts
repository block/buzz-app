import { expect, it, vi } from "vitest";
import type { LocalWork } from "./local-activity";
import { conversationWorkStops, requestTopLevel, workStop } from "./work-stop";

const activity = {
  interrupt: vi.fn(async () => {}),
} as unknown as Parameters<typeof workStop>[2];
const work = {
  agent: "agent",
  lifecycle: true,
  stoppable: true,
  state: "working",
  working: true,
} as const;

it("pauses the chat's queue only for a top-level Stop", async () => {
  const pause = vi.fn(async () => {});
  const top = workStop(
    work,
    { channelId: "chat", messageId: "m", topLevel: true },
    activity,
    undefined,
    pause,
  );
  await top?.pauseQueue?.();
  expect(pause).toHaveBeenCalledExactlyOnceWith("chat");
  const reply = workStop(
    work,
    { channelId: "chat", messageId: "r", threadRootId: "m", topLevel: false },
    activity,
    undefined,
    pause,
  );
  expect(reply?.interrupt).toBeDefined();
  expect(reply?.pauseQueue).toBeUndefined();
});

it("treats local work in a thread as thread-scoped", () => {
  const pause = vi.fn(async () => {});
  const row = (messageId: string, thread: boolean): LocalWork => ({
    scope: "scope",
    agent: "agent",
    channelId: "chat",
    messageId,
    threadRootId: thread ? "root" : messageId,
    ...(thread ? { thread: true as const } : {}),
    state: "working",
    startedAt: 1,
    stoppable: true,
  });
  const stops = conversationWorkStops(
    {
      status: "listening",
      typing: [],
      turns: [],
      records: [],
      local: [row("top", false), row("reply", true)],
    } as unknown as Parameters<typeof conversationWorkStops>[0],
    "agent",
    "chat",
    undefined,
    activity,
    undefined,
    pause,
  );
  expect(
    stops.map(({ control, work }) => [work?.messageId, !!control.pauseQueue]),
  ).toEqual([
    ["top", true],
    ["reply", false],
  ]);
});

it("leaves the queue alone when only a hosted thread reply is running", () => {
  const root = "a".repeat(64);
  const reply = "b".repeat(64);
  function frame(turnId: string, kind: string, time: number, trigger?: string) {
    return {
      agent: "agent",
      id: `${turnId}:${kind}`,
      receivedAt: time,
      plaintext: JSON.stringify({
        channelId: "chat",
        turnId,
        kind,
        payload: {
          threadRootEventId: root,
          ...(trigger ? { triggeringEventIds: [trigger] } : {}),
        },
      }),
    };
  }
  const stops = conversationWorkStops(
    {
      status: "listening",
      local: [],
      turns: [
        {
          agent: "agent",
          channelId: "chat",
          turnId: "reply",
          state: "working",
        },
      ],
      records: [
        frame("top", "turn_started", 1, root),
        frame("top", "turn_completed", 2),
        frame("reply", "turn_started", 3, reply),
      ],
    } as unknown as Parameters<typeof conversationWorkStops>[0],
    "agent",
    "chat",
    root,
    activity,
    { interruptible: () => true, interrupt: vi.fn(async () => true) },
    vi.fn(async () => {}),
  );
  expect(stops).toHaveLength(1);
  expect(stops[0]?.control.pauseQueue).toBeUndefined();
});

it("reads a request's scope from its own work", () => {
  const snapshot = (
    local: Partial<LocalWork>[],
    requests: { messageId: string; threadRootId: string }[] = [],
  ) =>
    ({
      status: "listening",
      records: [],
      typing: [],
      local: local.map((row) => ({
        scope: "s",
        agent: "agent",
        channelId: "chat",
        messageId: "request",
        threadRootId: "request",
        startedAt: 1,
        state: "working",
        ...row,
      })),
      turns: [
        {
          agent: "agent",
          channelId: "chat",
          turnId: "t",
          timestamp: 1,
          state: "working",
          requests,
        },
      ],
    }) as unknown as Parameters<typeof requestTopLevel>[0];
  expect(requestTopLevel(snapshot([{}]), "agent", "chat", "request")).toBe(
    true,
  );
  expect(
    requestTopLevel(snapshot([{ thread: true }]), "agent", "chat", "request"),
  ).toBe(false);
  expect(
    requestTopLevel(
      snapshot([], [{ messageId: "request", threadRootId: "request" }]),
      "agent",
      "chat",
      "request",
    ),
  ).toBe(true);
  expect(
    requestTopLevel(
      snapshot([], [{ messageId: "reply", threadRootId: "root" }]),
      "agent",
      "chat",
      "reply",
    ),
  ).toBe(false);
  expect(
    requestTopLevel(snapshot([]), "agent", "chat", "request"),
  ).toBeUndefined();
});
