import { beforeEach, expect, it, vi } from "vitest";
import type { AgentVoiceSeat } from "../../features/agents/service";
import { GooseProcess } from "./goose";
import { fakeSpawn } from "./goose-testing";
import { GooseVoiceSettings } from "./voice-settings";
import { openVoice, TRANSCRIPT_QUIET_MS, VOICE_STOP_TIMEOUT_MS } from "./voice";
import { REQUEST_TIMEOUT_MS } from "../../features/agent-harness/acp/process";

const media = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../../features/huddle/voice-media", () => ({
  openVoiceMedia: media.open,
}));
beforeEach(() => {
  vi.useRealTimers();
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
  openVoice(process, "session-1", seat, "You are Gander.", (run) => {
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
    {
      sessionId: "session-1",
      offerSdp: "offer",
      instructions: "You are Gander.",
    },
    REQUEST_TIMEOUT_MS,
  );
  expect(f.answer).toHaveBeenCalledWith("answer");
  await f.signaling.stop();
  expect(f.request).toHaveBeenLastCalledWith(
    "_goose/unstable/session/live-voice/stop",
    { sessionId: "session-1", interactionId: "voice-1" },
  );
});

it("fails only the seat, never the process, when goose stops voice slowly", async () => {
  vi.useFakeTimers();
  const fake = fakeSpawn({
    silent: ["_goose/unstable/session/live-voice/stop"],
  });
  const process = await GooseProcess.start(fake.spawn, {
    cwd: "/tmp",
    serve: fake.serve,
  });
  let wire!: Parameters<
    typeof import("../../features/huddle/voice-media").openVoiceMedia
  >[4];
  media.open.mockImplementation((_l, _s, _o, _e, signaling) => {
    wire = signaling;
    return signaling;
  });
  try {
    openVoice(
      process,
      "session-1",
      {
        signal: new AbortController().signal,
        output: vi.fn(),
        ended: vi.fn(),
      } as unknown as AgentVoiceSeat,
      "",
      (run) => run(),
    );
    await wire.start("offer");
    let settled = false;
    const stop = wire.stop().finally(() => (settled = true));
    const stopped = expect(stop).rejects.toThrow("in time");
    // goose may take 12 s to close and 20 s to clean up: neither kills it,
    // nor fails the seat early.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(settled).toBe(false);
    expect(fake.geese[0]?.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(VOICE_STOP_TIMEOUT_MS);
    await stopped;
    expect(fake.geese[0]?.killed).toBe(false);
  } finally {
    await process.kill();
    vi.useRealTimers();
  }
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
  expect(f.transcript).toHaveBeenLastCalledWith("agent", "later");
});

const spoken = (id: string, role: "user" | "agent", text: string) => ({
  sessionUpdate: `${role}_message_chunk`,
  content: { type: "text", text },
  _meta: { goose: { messageId: id, liveTranscript: true } },
});

it("posts the last spoken line once it goes quiet, while the seat is still in the room", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.update(spoken("u1", "user", "what time is it"));
  f.update(spoken("a1", "agent", "it is"));
  await vi.advanceTimersByTimeAsync(TRANSCRIPT_QUIET_MS - 1);
  f.update(spoken("a1", "agent", " noon "));
  await vi.advanceTimersByTimeAsync(TRANSCRIPT_QUIET_MS - 1);
  expect(f.transcript).toHaveBeenCalledExactlyOnceWith(
    "owner",
    "what time is it",
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(f.transcript).toHaveBeenLastCalledWith("agent", "it is noon");
  f.unsubscribe();
  expect(f.transcript).toHaveBeenCalledTimes(2);
});

it("posts the last spoken line when its interaction ends", async () => {
  const f = fixture();
  await f.signaling.start("offer");
  f.update(spoken("a1", "agent", "goodbye"));
  f.update(
    { sessionUpdate: "live_voice_interaction_ended", interactionId: "voice-1" },
    "_goose/unstable/session/update",
  );
  expect(f.transcript).toHaveBeenCalledExactlyOnceWith("agent", "goodbye");
  expect(f.fail).toHaveBeenCalledOnce();
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

it("switches off at once while a silent live start holds admission, which it releases on timeout", async () => {
  vi.useFakeTimers();
  const fake = fakeSpawn({
    silent: ["_goose/unstable/session/live-voice/start"],
  });
  const process = await GooseProcess.start(fake.spawn, {
    cwd: "/tmp",
    serve: fake.serve,
  });
  const changed = vi.fn();
  const settings = new GooseVoiceSettings(
    fake,
    {
      getItem: () => "true",
      setItem: vi.fn(),
    } as unknown as Storage,
    changed,
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
      "",
      (run) => settings.start(new AbortController().signal, run),
    );
    const failed = expect(wire.start("offer")).rejects.toThrow(
      "did not answer",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(
      fake.geese[0]?.received.some((m) =>
        m.method?.endsWith("live-voice/start"),
      ),
    ).toBe(true);
    // Switching off does not wait behind the start it holds.
    await settings.setEnabled(false);
    expect(settings.enabled).toBe(false);
    expect(changed).toHaveBeenCalledExactlyOnceWith(false);
    // A later switch on waits its turn, so it lands after the start ends.
    const on = settings.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    await on;
    expect(settings.enabled).toBe(true);
  } finally {
    await process.kill();
    vi.useRealTimers();
  }
});
