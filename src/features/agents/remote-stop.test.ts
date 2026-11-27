import { expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { createLocalAgentActivity } from "./local-activity";
import { type ControlRequest, remoteStop } from "./remote-stop";

const scope = "wss://relay.test:owner",
  agent = "a".repeat(64),
  root = "b".repeat(64),
  other = "c".repeat(64);
const frame = { id: "f".repeat(64) } as RelayEvent;

function turns() {
  const activity = createLocalAgentActivity();
  const begin = (
    messageId: string,
    threadRootId: string,
    over: Partial<{ agent: string; channelId: string }> = {},
  ) => {
    const work = activity.begin({
      scope,
      agent,
      channelId: "channel",
      messageId,
      threadRootId,
      ...over,
    });
    work.started();
    const stop = vi.fn(async () => {});
    work.interruptible(stop);
    return stop;
  };
  return { activity, begin };
}
function interruptOf(activity: ReturnType<typeof createLocalAgentActivity>) {
  const { interruptConversation } = activity.reader;
  if (!interruptConversation) throw new Error("Expected interruptConversation");
  return interruptConversation;
}
const host = (
  activity: ReturnType<typeof createLocalAgentActivity>,
  request: Partial<ControlRequest> = {},
) => ({
  interrupt: interruptOf(activity),
  decode: vi.fn(async () => ({
    eventId: frame.id,
    agent,
    channelId: "channel",
    threadRootId: root,
    requestId: "r-1",
    ...request,
  })),
  answer: vi.fn(async () => {}),
});

it("stops every turn the agent has in the thread and answers sent", async () => {
  const { activity, begin } = turns();
  const first = begin("1".repeat(64), root);
  const second = begin("2".repeat(64), root);
  const elsewhere = begin("3".repeat(64), other);
  const otherAgent = begin("4".repeat(64), root, { agent: other });
  const native = host(activity);
  await remoteStop(frame, scope, native);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  expect(elsewhere).not.toHaveBeenCalled();
  expect(otherAgent).not.toHaveBeenCalled();
  expect(native.answer).toHaveBeenCalledWith(agent, {
    channelId: "channel",
    requestId: "r-1",
    status: "sent",
  });
  expect(
    activity.reader.work().map(({ messageId, state }) => [messageId, state]),
  ).toEqual([
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
  expect(native.answer).toHaveBeenCalledWith(agent, {
    channelId: "channel",
    requestId: "r-1",
    status: "no_active_turn",
  });
  // Again once the turn there is stopped: it is settled, not active.
  const stopped = host(activity, { threadRootId: other });
  await remoteStop(frame, scope, stopped);
  await remoteStop(frame, scope, stopped);
  expect(stopped.answer.mock.calls.map(([, { status }]) => status)).toEqual([
    "sent",
    "no_active_turn",
  ]);
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
