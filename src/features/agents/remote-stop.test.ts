import { expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import type { CancelTurn } from "./agent-control";
import { createLocalAgentActivity } from "./local-activity";
import {
  type ControlAnswer,
  type ControlRequest,
  remoteStop,
} from "./remote-stop";

const scope = "wss://relay.test:owner",
  agent = "a".repeat(64),
  root = "b".repeat(64),
  other = "c".repeat(64);
const frame = { id: "f".repeat(64) } as RelayEvent;

function turns() {
  const activity = createLocalAgentActivity();
  /** A stoppable turn on `messageId`, in the thread on `threadRootId` unless
   * `topLevel`, as for a mention a plugin placed at the channel's top level. */
  const begin = (
    messageId: string,
    threadRootId: string,
    over: Partial<{ agent: string; channelId: string; topLevel: true }> = {},
  ) => {
    const { topLevel, ...rest } = over;
    const work = activity.begin({
      scope,
      agent,
      channelId: "channel",
      messageId,
      threadRootId,
      ...(topLevel ? {} : { thread: true as const }),
      ...rest,
    });
    work.started();
    const stop = vi.fn(async () => {});
    work.interruptible(stop);
    return stop;
  };
  return { activity, begin };
}
const thread = (threadRootId: string): CancelTurn => ({
  type: "cancel_thread_turn",
  channelId: "channel",
  threadRootId,
  requestId: "r-1",
});
const channel: CancelTurn = {
  type: "cancel_turn",
  channelId: "channel",
  requestId: "r-2",
};
function host(
  activity: ReturnType<typeof createLocalAgentActivity>,
  request: CancelTurn = thread(root),
) {
  const { work, interrupt } = activity.reader;
  if (!interrupt) throw new Error("Expected interrupt");
  return {
    work,
    interrupt,
    decode: vi.fn(
      async (): Promise<ControlRequest> => ({
        eventId: frame.id,
        agent,
        request,
      }),
    ),
    answer: vi.fn(async (_answer: ControlAnswer) => {}),
  };
}
const states = (activity: ReturnType<typeof createLocalAgentActivity>) =>
  activity.reader.work().map(({ messageId, state }) => [messageId, state]);

it("stops the agent's turns in the thread, and not top-level work on its root", async () => {
  const { activity, begin } = turns();
  // The root mention was placed at the channel's top level; its reply runs
  // in the thread.
  const rootTurn = begin(root, root, { topLevel: true });
  const first = begin("1".repeat(64), root);
  const second = begin("2".repeat(64), root);
  const elsewhere = begin("3".repeat(64), other);
  const otherAgent = begin("4".repeat(64), root, { agent: other });
  const native = host(activity);
  await remoteStop(frame, scope, native);
  expect(rootTurn).not.toHaveBeenCalled();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  expect(elsewhere).not.toHaveBeenCalled();
  expect(otherAgent).not.toHaveBeenCalled();
  expect(native.answer).toHaveBeenCalledWith({
    agent,
    type: "cancel_thread_turn",
    channelId: "channel",
    requestId: "r-1",
    status: "sent",
  });
  expect(states(activity)).toEqual([
    [root, "working"],
    ["1".repeat(64), "stopped"],
    ["2".repeat(64), "stopped"],
    ["3".repeat(64), "working"],
    ["4".repeat(64), "working"],
  ]);
});

it("answers no_active_turn when nothing there can be stopped", async () => {
  const { activity, begin } = turns();
  begin("3".repeat(64), other);
  const native = host(activity);
  await remoteStop(frame, scope, native);
  expect(native.answer).toHaveBeenCalledWith(
    expect.objectContaining({ status: "no_active_turn" }),
  );
  // Again once the turn there is stopped: it is settled, not active.
  const stopped = host(activity, thread(other));
  await remoteStop(frame, scope, stopped);
  await remoteStop(frame, scope, stopped);
  expect(stopped.answer.mock.calls.map(([{ status }]) => status)).toEqual([
    "sent",
    "no_active_turn",
  ]);
});

it("stops a channel's turns running in one place, and none when they run in several", async () => {
  const { activity, begin } = turns();
  const first = begin("1".repeat(64), root, { topLevel: true });
  const second = begin("2".repeat(64), "2".repeat(64), { topLevel: true });
  const otherChannel = begin("3".repeat(64), other, { channelId: "elsewhere" });
  const native = host(activity, channel);
  await remoteStop(frame, scope, native);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  expect(otherChannel).not.toHaveBeenCalled();
  expect(native.answer).toHaveBeenLastCalledWith({
    agent,
    type: "cancel_turn",
    channelId: "channel",
    requestId: "r-2",
    status: "sent",
  });
  // A turn at the top level and one in a thread: which one is meant is
  // unknown, so neither stops.
  const topLevel = begin("4".repeat(64), "4".repeat(64), { topLevel: true });
  const threaded = begin("5".repeat(64), root);
  await remoteStop(frame, scope, native);
  expect(topLevel).not.toHaveBeenCalled();
  expect(threaded).not.toHaveBeenCalled();
  expect(native.answer).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: "ambiguous_target" }),
  );
});

it("does not answer a frame native code refused", async () => {
  const { activity, begin } = turns();
  const stop = begin("1".repeat(64), root);
  const native = host(activity);
  native.decode.mockRejectedValueOnce(new Error("Invalid control frame"));
  await expect(remoteStop(frame, scope, native)).rejects.toThrow();
  expect(stop).not.toHaveBeenCalled();
  expect(native.answer).not.toHaveBeenCalled();
});
