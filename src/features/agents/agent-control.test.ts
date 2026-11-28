import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAgentActivity } from "./activity";
import {
  CONTROL_ANSWER_MS,
  CONTROL_HOLD_MS,
  ControlUnanswered,
  createAgentControl,
  type CancelTurn,
} from "./agent-control";
import type { RelayEvent } from "../relay/events";

const agent = "a".repeat(64);
const other = "b".repeat(64);
const root = "c".repeat(64);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A session's activity and control, with the relay's answers fed back as
 * decoded telemetry. */
function setup() {
  let generation: number | null = null;
  const observe = vi.fn((next: number | null) => {
    generation = next;
  });
  const activity = createAgentActivity(true, observe, () => true);
  const sent: CancelTurn[] = [];
  const publish = vi.fn(async (_event: RelayEvent) => "ok");
  let signing: Promise<void> = Promise.resolve();
  const control = createAgentControl({
    async sign(_agent, payload) {
      await signing;
      sent.push(payload);
      return { id: "e".repeat(64) } as RelayEvent;
    },
    publish,
    activity: {
      activate: activity.queries.activate,
      listening: () => activity.queries.snapshot().status === "listening",
      subscribe: (listener) => activity.queries.subscribe(listener),
      controlResults: activity.queries.controlResults,
    },
  });
  let frames = 0;
  // A stale frame is dated before the observer route started.
  let stale = false;
  const frame = (from: string, value: unknown) =>
    activity.receive(
      {
        id: (frames++).toString(16).padStart(64, "0"),
        agent: from,
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify(value),
      },
      generation ?? -1,
      stale,
    );
  type Type = CancelTurn["type"];
  const result = (status: string, requestId: string, type: Type) => ({
    kind: "control_result",
    channelId: "channel",
    payload: { type, status, requestId },
  });
  const answer = (
    from: string,
    status: string,
    requestId: string,
    type: Type = "cancel_turn",
  ) => frame(from, result(status, requestId, type));
  // An agent's publisher packs one tick's events for a channel into a batch.
  const batched = (
    from: string,
    status: string,
    requestId: string,
    type: Type = "cancel_thread_turn",
  ) =>
    frame(from, {
      kind: "batch",
      channelId: "channel",
      payload: {
        events: [
          { kind: "agent_message_chunk", channelId: "channel", payload: {} },
          result(status, requestId, type),
        ],
      },
    });
  const listen = () =>
    activity.state({
      status: "connected",
      routes: [{ id: "observer", status: "live" }],
    } as never);
  // The socket was replaced: its observer is being established again.
  const reconnect = () =>
    activity.state({
      status: "connected",
      routes: [{ id: "observer", status: "pending" }],
    } as never);
  const holdSigning = () => {
    let release = () => {};
    signing = new Promise((resolve) => (release = resolve));
    return release;
  };
  const clockBehind = () => (stale = true);
  return {
    activity,
    control,
    clockBehind,
    sent,
    publish,
    answer,
    batched,
    listen,
    reconnect,
    holdSigning,
    observe,
  };
}

it("sends once the observer listens, and resolves on the agent's own sent answer", async () => {
  const f = setup();
  const signed = f.holdSigning();
  const stop = f.control.cancelTurn(
    agent,
    { channelId: "channel", threadRootId: root },
    new AbortController().signal,
  );
  f.listen();
  // The connection is replaced while the host signs. Nothing goes out
  // before the answer could be heard on the new one.
  f.reconnect();
  signed();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.publish).not.toHaveBeenCalled();
  f.listen();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.publish).toHaveBeenCalledOnce();
  const [request] = f.sent;
  // A thread stop has the type a host too old to target one thread ignores.
  expect(request).toEqual({
    type: "cancel_thread_turn",
    channelId: "channel",
    threadRootId: root,
    requestId: expect.any(String),
  });
  const id = request?.requestId ?? "";
  // Answers to other stops, of another type, or from another agent, are not
  // this one's.
  f.answer(agent, "sent", crypto.randomUUID(), "cancel_thread_turn");
  f.answer(agent, "sent", id, "cancel_turn");
  f.answer(other, "sent", id, "cancel_thread_turn");
  let settled = false;
  void stop.then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  f.batched(agent, "sent", crypto.randomUUID());
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  // The answer usually ships batched with the agent's other telemetry.
  f.batched(agent, "sent", id);
  await expect(stop).resolves.toBe("sent");
  // The observer is let go once the stop settles.
  expect(f.observe).toHaveBeenLastCalledWith(null);
});

it("settles on an answer dated before the observer started, and shows nothing else from it", async () => {
  const f = setup();
  f.listen();
  const stop = f.control.cancelTurn(
    agent,
    { channelId: "channel", threadRootId: root },
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(0);
  const id = f.sent[0]?.requestId ?? "";
  f.activity.queries.activate();
  // The agent's clock runs behind: its frame predates the observer route.
  f.clockBehind();
  f.batched(agent, "sent", id);
  await expect(stop).resolves.toBe("sent");
  expect(f.activity.queries.snapshot()).toMatchObject({
    records: [],
    turns: [],
  });
});

it("holds a no_active_turn for a sent from another device, then settles on it", async () => {
  const f = setup();
  // The conversation already shows the agent's activity.
  f.activity.queries.activate();
  f.listen();
  const signal = new AbortController().signal;
  const place = { channelId: "channel" };
  const first = f.control.cancelTurn(agent, place, signal);
  await vi.advanceTimersByTimeAsync(0);
  // A Solo chat or DM names no thread.
  expect(f.sent[0]).toEqual({
    type: "cancel_turn",
    channelId: "channel",
    requestId: expect.any(String),
  });
  f.answer(agent, "no_active_turn", f.sent[0]?.requestId ?? "");
  await vi.advanceTimersByTimeAsync(CONTROL_HOLD_MS - 1);
  f.answer(agent, "sent", f.sent[0]?.requestId ?? "");
  await expect(first).resolves.toBe("sent");

  const second = f.control.cancelTurn(agent, place, signal);
  await vi.advanceTimersByTimeAsync(0);
  f.answer(agent, "no_active_turn", f.sent[1]?.requestId ?? "");
  await vi.advanceTimersByTimeAsync(CONTROL_HOLD_MS);
  await expect(second).resolves.toBe("no_active_turn");

  const third = f.control.cancelTurn(agent, place, signal);
  await vi.advanceTimersByTimeAsync(0);
  f.answer(agent, "ambiguous_target", f.sent[2]?.requestId ?? "");
  f.answer(agent, "no_active_turn", f.sent[2]?.requestId ?? "");
  await vi.advanceTimersByTimeAsync(CONTROL_HOLD_MS);
  await expect(third).resolves.toBe("ambiguous_target");
});

it("rejects when no answer comes in time", async () => {
  const f = setup();
  const stop = f.control.cancelTurn(
    agent,
    { channelId: "channel", threadRootId: root },
    new AbortController().signal,
  );
  f.listen();
  const failed = expect(stop).rejects.toBeInstanceOf(ControlUnanswered);
  await vi.advanceTimersByTimeAsync(CONTROL_ANSWER_MS);
  await failed;
  // A late answer changes nothing.
  f.answer(agent, "sent", f.sent[0]?.requestId ?? "");
  expect(f.observe).toHaveBeenLastCalledWith(null);
});
