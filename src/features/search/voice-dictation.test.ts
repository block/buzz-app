// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type VoiceBackend, useVoiceDictation } from "./voice-dictation";

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

let answer: (session: number) => void = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command !== "voice_search_start") return undefined;
    return new Promise<number>((resolve) => {
      answer = resolve;
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function dictation(backend: VoiceBackend = "apple") {
  const onText = vi.fn();
  const onPause = vi.fn();
  const onEnd = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() =>
    useVoiceDictation({ backend, onText, onPause, onEnd, onError }),
  );
  return { hook, onText, onPause, onEnd, onError };
}

const calls = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

it("streams the transcript, reports a pause, and ends with the final words", async () => {
  const { hook, onText, onPause, onEnd } = dictation();
  let started!: Promise<void>;
  act(() => {
    started = hook.result.current.start(["buzz security"]);
  });
  expect(hook.result.current.state).toBe("starting");
  expect(calls("voice_search_start")[0]?.[1]).toMatchObject({
    hints: ["buzz security"],
  });
  await act(async () => {
    answer(7);
    await started;
  });
  act(() => send({ kind: "listening" }));
  expect(hook.result.current.state).toBe("listening");
  act(() => send({ kind: "text", text: "take me to bus" }));
  act(() => send({ kind: "text", text: "take me to Buzz security" }));
  expect(onText).toHaveBeenLastCalledWith("take me to Buzz security");
  act(() => vi.advanceTimersByTime(599));
  expect(onPause).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(onPause).toHaveBeenCalledWith("take me to Buzz security");

  act(() => hook.result.current.stop());
  expect(calls("voice_search_finish")).toEqual([
    ["voice_search_finish", { session: 7 }],
  ]);
  // Listening goes on until the final transcript arrives.
  expect(onEnd).not.toHaveBeenCalled();
  act(() => send({ kind: "ended", text: "Take me to Buzz security." }));
  expect(onEnd).toHaveBeenCalledWith("Take me to Buzz security.");
  expect(hook.result.current.state).toBe("idle");
  act(() => send({ kind: "text", text: "late" }));
  expect(onText).not.toHaveBeenCalledWith("late");
});

it("reports what was heard when the final transcript doesn't come", async () => {
  const { hook, onEnd } = dictation();
  await act(async () => {
    const started = hook.result.current.start();
    answer(1);
    await started;
  });
  act(() => send({ kind: "listening" }));
  act(() => send({ kind: "text", text: "design" }));
  act(() => hook.result.current.stop());
  act(() => vi.advanceTimersByTime(999));
  expect(onEnd).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(onEnd).toHaveBeenCalledWith("design");
  expect(hook.result.current.state).toBe("idle");
});

it("cancels a listen that native code starts after it was cancelled", async () => {
  const { hook, onEnd } = dictation();
  let started!: Promise<void>;
  act(() => {
    started = hook.result.current.start();
  });
  act(() => hook.result.current.cancel());
  expect(hook.result.current.state).toBe("idle");
  await act(async () => {
    answer(3);
    await started;
  });
  expect(calls("voice_search_cancel")).toEqual([
    ["voice_search_cancel", { session: 3 }],
  ]);
  expect(onEnd).not.toHaveBeenCalled();
});

it("finishes a listen stopped before native code answered", async () => {
  const { hook } = dictation();
  let started!: Promise<void>;
  act(() => {
    started = hook.result.current.start();
  });
  act(() => hook.result.current.stop());
  await act(async () => {
    answer(4);
    await started;
  });
  expect(calls("voice_search_finish")).toEqual([
    ["voice_search_finish", { session: 4 }],
  ]);
});

it("reports a failure without ending on words", async () => {
  const { hook, onEnd, onError } = dictation();
  await act(async () => {
    const started = hook.result.current.start();
    answer(5);
    await started;
  });
  act(() => send({ kind: "text", text: "half" }));
  act(() =>
    send({
      kind: "error",
      message: "Allow Buzz to use your microphone to search by voice.",
    }),
  );
  expect(onError).toHaveBeenCalledWith(
    "Allow Buzz to use your microphone to search by voice.",
    "failed",
  );
  expect(onEnd).not.toHaveBeenCalled();
  expect(hook.result.current.state).toBe("idle");
});

it("ends a listen that hears nothing", async () => {
  const { hook, onEnd } = dictation();
  await act(async () => {
    const started = hook.result.current.start();
    answer(6);
    await started;
  });
  act(() => send({ kind: "listening" }));
  act(() => vi.advanceTimersByTime(8_000));
  expect(calls("voice_search_finish")).toHaveLength(1);
  act(() => send({ kind: "ended", text: "" }));
  expect(onEnd).not.toHaveBeenCalled();
  expect(hook.result.current.state).toBe("idle");
});

it("shows a first-use model download, then listens", async () => {
  const { hook } = dictation();
  await act(async () => {
    const started = hook.result.current.start();
    answer(8);
    await started;
  });
  act(() => send({ kind: "downloading" }));
  expect(hook.result.current.state).toBe("downloading");
  act(() => send({ kind: "listening" }));
  expect(hook.result.current.state).toBe("listening");
});

it("reports denied access apart from other failures", async () => {
  const { hook, onEnd, onError } = dictation();
  await act(async () => {
    const started = hook.result.current.start();
    answer(9);
    await started;
  });
  act(() => send({ kind: "denied", message: "Turn on the microphone." }));
  expect(onError).toHaveBeenCalledWith("Turn on the microphone.", "denied");
  expect(onEnd).not.toHaveBeenCalled();
  expect(hook.result.current.state).toBe("idle");
});

function realtime() {
  const channel = new EventTarget();
  const stopTrack = vi.fn();
  const track = { stop: stopTrack };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
  const getUserMedia = vi.fn(async () => stream);
  const replaceTrack = vi.fn(async () => {});
  const close = vi.fn();
  const setRemoteDescription = vi.fn(async () => {});
  const createDataChannel = vi.fn(() => channel);
  vi.stubGlobal(
    "RTCPeerConnection",
    class {
      addTransceiver = () => ({ sender: { replaceTrack } });
      createDataChannel = createDataChannel;
      createOffer = async () => ({ type: "offer", sdp: "voice offer" });
      setLocalDescription = async () => {};
      setRemoteDescription = setRemoteDescription;
      close = close;
    },
  );
  vi.stubGlobal(
    "navigator",
    Object.create(navigator, { mediaDevices: { value: { getUserMedia } } }),
  );
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command !== "voice_search_connect") throw new Error(command);
    return "voice answer";
  });
  return {
    ...dictation("realtime"),
    track,
    stream,
    stopTrack,
    getUserMedia,
    close,
    createDataChannel,
    replaceTrack,
    setRemoteDescription,
    receive(event: unknown) {
      channel.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(event) }),
      );
    },
  };
}

it("uses native SDP, reports a hosted pause at 800 ms, and stops with what it heard", async () => {
  const r = realtime();
  await act(() => r.hook.result.current.start(["Apple hint"]));
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["voice_search_connect", { offer: "voice offer" }],
  ]);
  expect(r.createDataChannel).toHaveBeenCalledWith("oai-events");
  expect(r.replaceTrack).toHaveBeenCalledWith(r.track);
  expect(r.setRemoteDescription).toHaveBeenCalledWith({
    type: "answer",
    sdp: "voice answer",
  });
  expect(r.hook.result.current.state).toBe("listening");

  const type = "conversation.item.input_audio_transcription";
  act(() => r.receive({ type: `${type}.delta`, delta: "Open" }));
  act(() => r.receive({ type: `${type}.delta`, delta: " design" }));
  act(() =>
    r.receive({ type: `${type}.completed`, transcript: "Open design" }),
  );
  expect(r.onText.mock.calls).toEqual([["Open"], ["Open design"]]);
  act(() => vi.advanceTimersByTime(799));
  expect(r.onPause).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(r.onPause).toHaveBeenCalledWith("Open design");
  expect(r.hook.result.current.state).toBe("listening");

  act(() => r.hook.result.current.stop());
  expect(r.onEnd.mock.calls).toEqual([["Open design"]]);
  expect(r.stopTrack).toHaveBeenCalledOnce();
  expect(r.close).toHaveBeenCalledOnce();
  expect(r.hook.result.current.state).toBe("idle");
  act(() => r.receive({ type: `${type}.delta`, delta: " late" }));
  expect(r.onText).toHaveBeenCalledTimes(2);
});

it("releases a hosted microphone granted after cancellation", async () => {
  const r = realtime();
  let started!: Promise<void>;
  let grant!: () => void;
  const requested = new Promise<void>((resolve) => {
    r.getUserMedia.mockImplementationOnce(
      () =>
        new Promise((done) => {
          grant = () => done(r.stream);
          resolve();
        }),
    );
  });
  await act(async () => {
    started = r.hook.result.current.start();
    await requested;
  });
  act(() => r.hook.result.current.cancel());
  expect(r.close).toHaveBeenCalledOnce();
  await act(async () => {
    grant();
    await started;
  });
  expect(r.stopTrack).toHaveBeenCalledOnce();
  expect(r.setRemoteDescription).not.toHaveBeenCalled();
  expect(r.onEnd).not.toHaveBeenCalled();
  expect(r.hook.result.current.state).toBe("idle");
});

it("treats hosted microphone denial as denied access", async () => {
  const r = realtime();
  r.getUserMedia.mockRejectedValueOnce(
    new DOMException("Denied", "NotAllowedError"),
  );
  await act(() => r.hook.result.current.start());
  expect(r.onError).toHaveBeenCalledWith(
    "Allow Buzz to use your microphone to search by voice.",
    "denied",
  );
  expect(r.close).toHaveBeenCalledOnce();
  expect(r.hook.result.current.state).toBe("idle");
});
