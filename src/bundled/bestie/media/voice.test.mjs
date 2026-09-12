import { afterEach, expect, it, vi } from "vitest";
import { openVoice } from "./voice.mjs";

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

/** Real openVoice/ACP stream; only the browser device and HTTP boundaries are modeled. */
function harness(settings = {}) {
  const requests = [],
    contexts = [],
    nodes = [],
    permissions = [];
  const abort = new AbortController();
  let events, voice, promptId;
  class Track extends EventTarget {
    label = "Test microphone";
    enabled = true;
    muted = false;
    readyState = "live";
    getSettings = () => ({ sampleRate: 48000 });
    stop = vi.fn(() => {
      this.readyState = "ended";
    });
  }
  const track = new Track();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const getUserMedia = vi.fn(
    () => settings.microphone?.promise ?? Promise.resolve(stream),
  );
  class DeviceContext {
    sampleRate = 24000;
    state = "running";
    destination = {};
    audioWorklet = {
      addModule: vi.fn(async () => {
        if (settings.workletError) throw Error("Worklet unavailable");
      }),
    };
    resume = vi.fn(async () => {});
    close = vi.fn(async () => {
      this.state = "closed";
      if (settings.closeError) throw Error("Device close failed");
    });
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
    createAnalyser = vi.fn(() => ({}));
    constructor() {
      contexts.push(this);
    }
  }
  class DeviceNode {
    messages = [];
    connect = vi.fn();
    disconnect = vi.fn();
    port = {
      onmessage: null,
      postMessage: (data) => {
        this.messages.push(data);
        if (data.type === "clear" && !settings.holdClear)
          queueMicrotask(() =>
            this.port.onmessage?.({
              data: { type: "stopped", requestId: data.requestId },
            }),
          );
      },
    };
    constructor() {
      nodes.push(this);
    }
  }
  const push = (event) =>
    events.enqueue(
      new TextEncoder().encode(
        `${JSON.stringify({ jsonrpc: "2.0", ...event })}\n`,
      ),
    );
  const media = (update) =>
    push({
      method: "_buzz/unstable/realtime/update",
      params: { sessionId: "test-session", streamId: "test-stream", update },
    });
  const fetch = vi.fn(async (url, init = {}) => {
    if (String(url).includes("op=events")) {
      if (settings.connectStatus)
        return new Response("", { status: settings.connectStatus });
      return new Response(
        new ReadableStream({
          start(controller) {
            events = controller;
            init.signal.addEventListener(
              "abort",
              () => {
                try {
                  events.error(new DOMException("Cancelled", "AbortError"));
                } catch {
                  /* Stream already ended. */
                }
              },
              { once: true },
            );
          },
        }),
      );
    }
    if (init.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const event = JSON.parse(init.body);
    requests.push({ ...event, signal: init.signal });
    if (settings.rejectMethod && event.method === settings.rejectMethod)
      return new Response("", { status: 503 });
    if (settings.holdMethod && event.method === settings.holdMethod)
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        ),
      );
    if (event.method === "initialize")
      push({
        id: event.id,
        result: {
          agentCapabilities: { _meta: { buzz: { realtimeAudio: 1 } } },
        },
      });
    else if (event.method === "session/new")
      push({ id: event.id, result: { sessionId: "test-session" } });
    else if (event.method === "session/prompt") {
      promptId = event.id;
      if (!settings.holdReady) media({ type: "ready" });
    } else if (event.method === "_buzz/unstable/realtime/close") {
      push({ id: event.id, result: {} });
      push({ id: promptId, result: { stopReason: "end_turn" } });
    } else if (event.id !== undefined && event.method)
      push({ id: event.id, result: {} });
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("AudioContext", DeviceContext);
  vi.stubGlobal("AudioWorkletNode", DeviceNode);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("fetch", fetch);
  const ui = {
    evidence: vi.fn(),
    status: vi.fn(),
    analyzers: vi.fn(),
    transcript: vi.fn(),
    userTranscript: vi.fn(),
    removeInput: vi.fn(),
    ended: vi.fn(),
    event: vi.fn(),
    permission: vi.fn((tool, decide) => {
      permissions.push({ tool, decide });
    }),
  };
  const open = () =>
    openVoice("call-token", ui, {
      signal: abort.signal,
      eventsUrl: "/bestie?op=events",
      rpcUrl: "/bestie?op=rpc",
      created(value) {
        voice = value;
      },
    });
  cleanups.push(async () => {
    abort.abort();
    await voice?.stop(false).catch(() => {});
    await settle();
  });
  return {
    open,
    ended: ui.ended,
    abort,
    ui,
    permissions,
    requests,
    contexts,
    nodes,
    stream,
    track,
    getUserMedia,
    fetch,
    push,
    media,
    voice: () => voice,
    permission(id) {
      push({
        id,
        method: "session/request_permission",
        params: {
          sessionId: "test-session",
          toolCall: { toolCallId: id, title: `Tool ${id}` },
          options: [
            { kind: "allow_once", optionId: "yes" },
            { kind: "reject_once", optionId: "no" },
          ],
        },
      });
    },
    endEvents() {
      events.close();
    },
  };
}

it("negotiates ACP, captures aligned duplex PCM, and concurrent stops share one cleanup", async () => {
  const h = harness();
  const voice = await h.open();
  expect(h.requests.slice(0, 3).map((event) => event.method)).toEqual([
    "initialize",
    "session/new",
    "session/prompt",
  ]);
  const node = h.nodes[0];
  node.port.onmessage({
    data: {
      type: "capture",
      pcm: new Int16Array([1, 2]),
      playback: new Int16Array([3, 4]),
      captureTime: 1,
      captureSamples: 2,
    },
  });
  await settle();
  const append = h.requests.find((event) => event.method?.endsWith("/append"));
  expect(append.params).toMatchObject({
    sequence: 0,
    data: "AQACAA==",
    playbackData: "AwAEAA==",
    sessionId: "test-session",
    streamId: "test-stream",
  });
  const first = voice.stop(true),
    second = voice.stop(false);
  expect(first).toBe(second);
  expect(h.track.stop).toHaveBeenCalledTimes(1);
  await first;
  expect(h.contexts[0].close).toHaveBeenCalledTimes(1);
  expect(node.disconnect).toHaveBeenCalledTimes(1);
  expect(node.port.onmessage).toBeNull();
  expect(h.ended).toHaveBeenCalledTimes(1);
});

it("a pre-cancelled call never opens network or device resources", async () => {
  const h = harness();
  h.abort.abort();
  await expect(h.open()).rejects.toThrow("Connection cancelled");
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.getUserMedia).not.toHaveBeenCalled();
  expect(h.ended).toHaveBeenCalledTimes(1);
});

it("a microphone permission resolving after cancellation is stopped without starting a prompt", async () => {
  const microphone = deferred();
  const h = harness({ microphone });
  const opening = h.open();
  const rejected = expect(opening).rejects.toThrow(
    "Session closed during microphone setup",
  );
  await vi.waitFor(() => expect(h.getUserMedia).toHaveBeenCalledTimes(1));
  h.abort.abort();
  await h.voice().stop(false);
  microphone.resolve(h.stream);
  await rejected;
  expect(h.track.stop).toHaveBeenCalledTimes(1);
  expect(h.contexts[0].close).toHaveBeenCalledTimes(1);
  expect(h.requests.some((event) => event.method === "session/prompt")).toBe(
    false,
  );
  expect(
    h.nodes[0].messages.some(
      (event) => event.type === "capture" && event.enabled,
    ),
  ).toBe(false);
});

it.each(["connect", "worklet", "microphone", "session/prompt"])(
  "cleans up a %s startup failure and exposes one ended event",
  async (stage) => {
    const microphone = stage === "microphone" ? deferred() : undefined;
    const h = harness({
      connectStatus: stage === "connect" ? 503 : undefined,
      workletError: stage === "worklet",
      microphone,
      rejectMethod: stage === "session/prompt" ? "session/prompt" : undefined,
    });
    const opening = h.open();
    const rejected = expect(opening).rejects.toThrow();
    if (microphone) {
      await vi.waitFor(() => expect(h.getUserMedia).toHaveBeenCalled());
      microphone.reject(
        new DOMException("Permission denied", "NotAllowedError"),
      );
    }
    await rejected;
    await h
      .voice()
      ?.stop(false)
      .catch(() => {});
    expect(h.ended).toHaveBeenCalledTimes(1);
    for (const context of h.contexts)
      expect(context.close).toHaveBeenCalledTimes(1);
    if (stage === "session/prompt")
      expect(h.track.stop).toHaveBeenCalledTimes(1);
  },
);

it.each(["speech", "failed", "completed"])(
  "an approval cancelled by %s cannot authorize a later request",
  async (change) => {
    const h = harness();
    const voice = await h.open();
    h.permission("A");
    await settle();
    const first = h.permissions.at(-1).decide;
    if (change === "speech") h.media({ type: "speech_started" });
    else
      h.push({
        method: "session/update",
        params: {
          sessionId: "test-session",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "A",
            status: change,
          },
        },
      });
    await settle();
    expect(h.permissions.at(-1).tool).toBeNull();
    h.permission("B");
    await settle();
    const second = h.permissions.at(-1).decide;
    await first("allow_once");
    expect(h.requests.filter((event) => !event.method)).toHaveLength(0);
    await second("reject_once");
    await second("allow_once");
    expect(h.requests.filter((event) => !event.method)).toMatchObject([
      { id: "B", result: { outcome: { optionId: "no" } } },
    ]);
    await voice.stop(false);
  },
);

it("cancels an in-flight capture request and stops tracks synchronously on revocation", async () => {
  const h = harness({ holdMethod: "_buzz/unstable/realtime/append" });
  const voice = await h.open();
  h.nodes[0].port.onmessage({
    data: {
      type: "capture",
      pcm: new Int16Array([1]),
      playback: new Int16Array([0]),
    },
  });
  await settle();
  const append = h.requests.find((event) => event.method?.endsWith("/append"));
  expect(append.signal.aborted).toBe(false);
  h.abort.abort();
  expect(h.track.stop).toHaveBeenCalledTimes(1);
  expect(append.signal.aborted).toBe(true);
  await voice.stop(false);
  expect(h.ended).toHaveBeenCalledTimes(1);
});

it("server disconnect releases the device and rejects stale permission callbacks", async () => {
  const h = harness();
  const voice = await h.open();
  h.permission("A");
  await settle();
  const decide = h.permissions.at(-1).decide;
  h.endEvents();
  await vi.waitFor(() => expect(h.ended).toHaveBeenCalledTimes(1));
  await decide("allow_once");
  expect(h.requests.filter((event) => !event.method)).toHaveLength(0);
  expect(h.track.stop).toHaveBeenCalledTimes(1);
  await voice.stop(false);
});

it("finishes local cleanup even when closing the audio device rejects", async () => {
  const h = harness({ closeError: true });
  const voice = await h.open();
  await voice.stop(false).catch(() => {});
  expect(h.ended).toHaveBeenCalledTimes(1);
  expect(h.nodes[0].port.onmessage).toBeNull();
  expect(h.track.stop).toHaveBeenCalledTimes(1);
});

it("buffered notifications after stop cannot restart callbacks or playback cleanup", async () => {
  const h = harness({ holdClear: true });
  const voice = await h.open();
  h.ui.status.mockClear();
  const stopping = voice.stop(true);
  h.media({ type: "ready" });
  h.push({
    method: "session/update",
    params: {
      sessionId: "test-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Late transcript" },
      },
    },
  });
  h.media({ type: "clear", itemId: "late-item" });
  await settle();
  expect(h.ui.status).not.toHaveBeenCalled();
  expect(h.ui.transcript).not.toHaveBeenCalled();
  const clears = h.nodes[0].messages.filter((event) => event.type === "clear");
  expect(clears).toHaveLength(1);
  h.nodes[0].port.onmessage({
    data: { type: "stopped", requestId: clears[0].requestId },
  });
  await stopping;
  expect(h.ended).toHaveBeenCalledTimes(1);
  expect(
    h.requests.some(
      (event) => event.method === "_buzz/unstable/realtime/close",
    ),
  ).toBe(true);
});
