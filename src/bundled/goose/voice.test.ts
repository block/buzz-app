import { beforeEach, expect, it, vi } from "vitest";
import type { AgentVoiceSeat } from "../../features/agents/service";
import { GooseProcess } from "./goose";
import { fakeSpawn } from "./goose-testing";
import { GooseVoiceSettings } from "./voice-settings";
import { openVoice } from "./voice";
import {
  REQUEST_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
} from "../../features/agent-harness/acp/process";

const media = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../../features/huddle/voice-media", () => ({
  openVoiceMedia: media.open,
}));
beforeEach(() => {
  media.open.mockReset();
});
function fixture() {
  let receive!: (method: string, params: Record<string, unknown>) => void;
  const request = vi.fn(async () => ({
    interactionId: "voice-1",
    answerSdp: "answer",
  }));
  const off = vi.fn();
  const process = {
    request,
    exited: new Promise(() => {}),
    onNotification: (callback: typeof receive) => {
      receive = callback;
      return off;
    },
  } as unknown as GooseProcess;
  const transcript = vi.fn(async () => {});
  const seat = {
    signal: new AbortController().signal,
    transcript,
    output: vi.fn(),
    ended: vi.fn(),
  } as unknown as AgentVoiceSeat;
  const fail = vi.fn();
  const answer = vi.fn();
  let unsubscribe!: () => void;
  let signaling!: Parameters<
    typeof import("../../features/huddle/voice-media").openVoiceMedia
  >[4];
  media.open.mockImplementation((_label, _signal, _output, _ended, wire) => {
    signaling = wire;
    unsubscribe = wire.subscribe(answer, fail);
    return wire;
  });
  const admit = vi.fn();
  openVoice(process, "session-1", seat, (run) => {
    admit();
    return run();
  });
  const update = (
    message: Record<string, unknown>,
    method = "session/update",
  ) => receive(method, { sessionId: "session-1", update: message });
  return {
    request,
    transcript,
    fail,
    answer,
    signaling,
    admit,
    update,
    off,
    unsubscribe,
  };
}

it("routes the actual start through admission and stops the returned interaction", async () => {
  const f = fixture();
  await f.signaling.start("offer");
  expect(f.admit).toHaveBeenCalledOnce();
  expect(f.request).toHaveBeenCalledWith(
    "_goose/unstable/session/live-voice/start",
    { sessionId: "session-1", offerSdp: "offer" },
    REQUEST_TIMEOUT_MS,
  );
  expect(f.answer).toHaveBeenCalledWith("answer");
  await f.signaling.stop();
  expect(f.request).toHaveBeenLastCalledWith(
    "_goose/unstable/session/live-voice/stop",
    { sessionId: "session-1", interactionId: "voice-1" },
    STOP_TIMEOUT_MS,
  );
});

it("groups only marked transcript deltas, leaving delegated output to the main session", async () => {
  const f = fixture();
  const chunk = (id: string, text: string, marked: boolean) => ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    _meta: { goose: { messageId: id, liveTranscript: marked } },
  });
  f.update(chunk("spoken", "hello ", true));
  f.update(chunk("typed", "tool result", false));
  f.update(chunk("spoken", "world", true));
  f.update(chunk("next", "later", true));
  expect(f.transcript).toHaveBeenCalledExactlyOnceWith("agent", "hello world");
  f.unsubscribe();
  expect(f.off).toHaveBeenCalledOnce();
});

it("fails an interaction that ended before its start response arrived", async () => {
  const f = fixture();
  f.request.mockImplementationOnce(async () => {
    f.update(
      {
        sessionUpdate: "live_voice_interaction_ended",
        interactionId: "voice-1",
      },
      "_goose/unstable/session/update",
    );
    return { interactionId: "voice-1", answerSdp: "answer" };
  });
  await expect(f.signaling.start("offer")).rejects.toThrow("ended");
  expect(f.answer).not.toHaveBeenCalled();
});

it("releases admission after a silent live start times out", async () => {
  vi.useFakeTimers();
  const fake = fakeSpawn({
    silent: ["_goose/unstable/session/live-voice/start"],
  });
  const process = await GooseProcess.start(fake.spawn, {
    cwd: "/tmp",
    serve: fake.serve,
  });
  const settings = new GooseVoiceSettings(
    fake,
    {
      getItem: () => "true",
      setItem: vi.fn(),
    } as unknown as Storage,
    vi.fn(),
  );
  let wire!: Parameters<
    typeof import("../../features/huddle/voice-media").openVoiceMedia
  >[4];
  media.open.mockImplementation(
    (_label, _signal, _output, _ended, signaling) => {
      wire = signaling;
      return signaling;
    },
  );
  try {
    openVoice(
      process,
      "session-1",
      {
        signal: new AbortController().signal,
        output: vi.fn(),
        ended: vi.fn(),
      } as unknown as AgentVoiceSeat,
      (run) => settings.start(new AbortController().signal, run),
    );
    const failed = expect(wire.start("offer")).rejects.toThrow(
      "did not answer",
    );
    const toggled = settings.setEnabled(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      fake.geese[0]?.received.some((m) =>
        m.method?.endsWith("live-voice/start"),
      ),
    ).toBe(true);
    expect(settings.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    await toggled;
    expect(settings.enabled).toBe(false);
  } finally {
    await process.kill();
    vi.useRealTimers();
  }
});
