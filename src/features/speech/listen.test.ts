// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type Connect,
  type ListenOptions,
  listenHosted,
  listenOnDevice,
  transcriptItems,
} from "./listen";

type Send = (event: unknown) => void;
let send: Send = () => {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(onmessage: Send) {
      send = onmessage;
    }
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function callbacks() {
  const onText = vi.fn();
  const onPause = vi.fn();
  const onEnd = vi.fn();
  const onError = vi.fn();
  const onState = vi.fn();
  const options: ListenOptions = { onText, onPause, onEnd, onError, onState };
  return { options, onText, onPause, onEnd, onError, onState };
}

const DELTA = "conversation.item.input_audio_transcription.delta";
const COMPLETED = "conversation.item.input_audio_transcription.completed";
const COMMIT = JSON.stringify({ type: "input_audio_buffer.commit" });

function hosted(
  reply: Awaited<ReturnType<Connect>> = { outcome: "answered", sdp: "answer" },
) {
  const channel = Object.assign(new EventTarget(), {
    readyState: "open",
    send: vi.fn(),
    close: vi.fn(),
  });
  const stopTrack = vi.fn();
  const track = { stop: stopTrack };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const getUserMedia = vi.fn(async () => stream);
  const replaceTrack = vi.fn(async () => {});
  const close = vi.fn();
  const setRemoteDescription = vi.fn(async () => {});
  vi.stubGlobal(
    "RTCPeerConnection",
    class {
      addTransceiver = () => ({ sender: { replaceTrack } });
      createDataChannel = () => channel;
      createOffer = async () => ({ type: "offer", sdp: "the offer" });
      setLocalDescription = async () => {};
      setRemoteDescription = setRemoteDescription;
      close = close;
    },
  );
  vi.stubGlobal(
    "navigator",
    Object.create(navigator, { mediaDevices: { value: { getUserMedia } } }),
  );
  const connect = vi.fn<Connect>(async () => reply);
  const c = callbacks();
  return {
    ...c,
    connect,
    channel,
    stream,
    track,
    stopTrack,
    close,
    getUserMedia,
    replaceTrack,
    setRemoteDescription,
    commits: () =>
      channel.send.mock.calls.filter(([data]) => data === COMMIT).length,
    receive(event: unknown) {
      channel.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(event) }),
      );
    },
    async start() {
      const listening = listenHosted(c.options, connect);
      await vi.advanceTimersByTimeAsync(0);
      return listening;
    },
  };
}

it("keeps each item's words and lets its completed text replace them", () => {
  const items = transcriptItems();
  items.apply({ type: DELTA, item_id: "a", delta: "Open" });
  items.apply({ type: DELTA, item_id: "a", delta: " desing" });
  expect(items.settled()).toBe(false);
  items.apply({ type: COMPLETED, item_id: "a", transcript: "Open design" });
  items.apply({ type: DELTA, item_id: "b", delta: "now" });
  expect(items.text()).toBe("Open design now");
  // A late delta for a finished item changes nothing.
  expect(items.apply({ type: DELTA, item_id: "a", delta: "x" })).toBe(false);
  items.apply({ type: COMPLETED, item_id: "b", transcript: "now." });
  expect(items.text()).toBe("Open design now.");
  expect(items.settled()).toBe(true);
});

it("answers through the provider, commits at each pause, and reports the settled words", async () => {
  const r = hosted();
  const listening = await r.start();
  expect(r.connect).toHaveBeenCalledWith("the offer", expect.any(AbortSignal));
  expect(r.replaceTrack).toHaveBeenCalledWith(r.track);
  expect(r.setRemoteDescription).toHaveBeenCalledWith({
    type: "answer",
    sdp: "answer",
  });
  expect(r.onState.mock.calls).toEqual([["starting"], ["listening"]]);

  r.receive({ type: DELTA, item_id: "a", delta: "Open" });
  r.receive({ type: DELTA, item_id: "a", delta: " desing" });
  expect(r.onText.mock.calls).toEqual([["Open"], ["Open desing"]]);
  vi.advanceTimersByTime(799);
  expect(r.onPause).not.toHaveBeenCalled();
  expect(r.commits()).toBe(0);
  vi.advanceTimersByTime(1);
  // The pause commits the utterance, so its words settle and it is metered.
  expect(r.onPause.mock.calls).toEqual([["Open desing"]]);
  expect(r.commits()).toBe(1);
  r.receive({ type: COMPLETED, item_id: "a", transcript: "Open design" });
  // Settled words are the same pause again, at once.
  expect(r.onPause.mock.calls).toEqual([["Open desing"], ["Open design"]]);
  // Nothing new since the commit: the next pause does not commit again.
  vi.advanceTimersByTime(800);
  expect(r.commits()).toBe(1);

  listening.stop();
  expect(r.commits()).toBe(1);
  expect(r.onEnd.mock.calls).toEqual([["Open design"]]);
  expect(r.stopTrack).toHaveBeenCalledOnce();
  expect(r.close).toHaveBeenCalledOnce();
  expect(r.onState).toHaveBeenLastCalledWith("idle");
  r.receive({ type: DELTA, item_id: "b", delta: " late" });
  expect(r.onText).toHaveBeenCalledTimes(3);
});

it("commits the last words on stop and waits for them", async () => {
  const r = hosted();
  const listening = await r.start();
  r.receive({ type: DELTA, item_id: "a", delta: "jump to" });
  listening.stop();
  expect(r.commits()).toBe(1);
  expect(r.onEnd).not.toHaveBeenCalled();
  r.receive({ type: COMPLETED, item_id: "a", transcript: "Jump to general." });
  expect(r.onEnd.mock.calls).toEqual([["Jump to general."]]);
  expect(r.close).toHaveBeenCalledOnce();
});

it("reports what it heard when the final words don't come", async () => {
  const r = hosted();
  const listening = await r.start();
  r.receive({ type: DELTA, item_id: "a", delta: "jump to" });
  listening.stop();
  vi.advanceTimersByTime(999);
  expect(r.onEnd).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(r.onEnd.mock.calls).toEqual([["jump to"]]);
});

it("ends after a long pause, and after silence without reporting", async () => {
  const r = hosted();
  await r.start();
  r.receive({ type: DELTA, item_id: "a", delta: "hello" });
  vi.advanceTimersByTime(800);
  r.receive({ type: COMPLETED, item_id: "a", transcript: "Hello." });
  vi.advanceTimersByTime(2_200);
  expect(r.onEnd.mock.calls).toEqual([["Hello."]]);

  const quiet = hosted();
  await quiet.start();
  vi.advanceTimersByTime(8_000);
  expect(quiet.onEnd).not.toHaveBeenCalled();
  expect(quiet.onState).toHaveBeenLastCalledWith("idle");
  expect(quiet.commits()).toBe(0);
});

it("reports the provider's refusal and releases the microphone", async () => {
  const r = hosted({ outcome: "failed", reason: "rate_limited" });
  await r.start();
  expect(r.onError).toHaveBeenCalledWith(
    "rate_limited",
    expect.stringContaining("Try again later"),
  );
  expect(r.stopTrack).toHaveBeenCalledOnce();
  expect(r.close).toHaveBeenCalledOnce();
  expect(r.onState).toHaveBeenLastCalledWith("idle");
});

it("ignores an empty commit but fails on other Realtime errors", async () => {
  const r = hosted();
  await r.start();
  r.receive({
    type: "error",
    error: { code: "input_audio_buffer_commit_empty", message: "empty" },
  });
  expect(r.onError).not.toHaveBeenCalled();
  r.receive({ type: "error", error: { message: "boom" } });
  expect(r.onError).toHaveBeenCalledWith("service_error", "boom");
  expect(r.close).toHaveBeenCalledOnce();
});

it("reports what it heard when the provider hangs up", async () => {
  const r = hosted();
  await r.start();
  r.receive({ type: DELTA, item_id: "a", delta: "cut off" });
  r.channel.dispatchEvent(new Event("close"));
  expect(r.onEnd.mock.calls).toEqual([["cut off"]]);
});

it("releases a microphone granted after cancellation", async () => {
  const r = hosted();
  let grant!: () => void;
  r.getUserMedia.mockImplementationOnce(
    () => new Promise((done) => (grant = () => done(r.stream))),
  );
  const listening = listenHosted(r.options, r.connect);
  await vi.advanceTimersByTimeAsync(0);
  listening.cancel();
  grant();
  await vi.advanceTimersByTimeAsync(0);
  expect(r.stopTrack).toHaveBeenCalledOnce();
  expect(r.replaceTrack).not.toHaveBeenCalled();
  expect(r.onEnd).not.toHaveBeenCalled();
});

it("maps a denied microphone to denied", async () => {
  const r = hosted();
  r.getUserMedia.mockRejectedValueOnce(
    new DOMException("nope", "NotAllowedError"),
  );
  await r.start();
  expect(r.onError).toHaveBeenCalledWith("denied", expect.any(String));
});

it("streams on-device words, pauses at 600 ms, and ends with the final words", async () => {
  let answer!: (session: number) => void;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command !== "speech_on_device_start") return undefined;
    return new Promise<number>((resolve) => (answer = resolve));
  });
  const c = callbacks();
  const listening = listenOnDevice({ ...c.options, hints: ["buzz security"] });
  expect(vi.mocked(invoke).mock.calls[0]?.[1]).toMatchObject({
    hints: ["buzz security"],
  });
  answer(7);
  await vi.advanceTimersByTimeAsync(0);
  send({ kind: "listening" });
  send({ kind: "text", text: "buzz" });
  vi.advanceTimersByTime(600);
  expect(c.onPause.mock.calls).toEqual([["buzz"]]);
  send({ kind: "text", text: "buzz security" });
  listening.stop();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("speech_on_device_finish", {
    session: 7,
  });
  send({ kind: "ended", text: "buzz security" });
  expect(c.onEnd.mock.calls).toEqual([["buzz security"]]);
  expect(c.onState.mock.calls.map(([state]) => state)).toEqual([
    "starting",
    "listening",
    "idle",
  ]);
});

it("reports denied on-device access with native's message", async () => {
  vi.mocked(invoke).mockResolvedValue(3);
  const c = callbacks();
  listenOnDevice(c.options);
  await vi.advanceTimersByTimeAsync(0);
  send({ kind: "denied", message: "Turn on speech recognition" });
  expect(c.onError).toHaveBeenCalledWith(
    "denied",
    "Turn on speech recognition",
  );
  expect(c.onState).toHaveBeenLastCalledWith("idle");
});
