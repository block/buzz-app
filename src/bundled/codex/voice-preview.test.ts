import { afterEach, expect, it, vi } from "vitest";
import { previewVoice } from "./voice-preview";
import { openVoice } from "./voice";

const rpc = vi.hoisted(() => ({
  open: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  request: vi.fn(async () => ({ thread: { id: "preview" } })),
}));
vi.mock("./rpc", () => ({
  AppServer: vi.fn(function AppServerMock() {
    return rpc;
  }),
}));
vi.mock("./voice", () => ({ openVoice: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function fixture(resume = Promise.resolve()) {
  vi.useFakeTimers();
  const close = vi.fn(async () => {});
  const input = vi.fn();
  const context = {
    destination: {},
    currentTime: 0,
    resume: () => resume,
    close,
    decodeAudioData: async () => ({
      getChannelData: () => new Float32Array(1920).fill(0.1),
    }),
    createBuffer: () => ({ copyToChannel: vi.fn(), duration: 0.02 }),
    createBufferSource: () => ({
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      disconnect: vi.fn(),
    }),
  };
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function AudioContextMock() {
      return context;
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(1),
    })),
  );
  vi.mocked(openVoice).mockImplementation(
    async (_rpc, _thread, _signal, output) => ({
      close: async () => {},
      input: (samples) => {
        input(samples);
        void output([0.5]);
      },
    }),
  );
  const abort = new AbortController();
  const spawn = vi.fn();
  return {
    close,
    context,
    input,
    abort,
    spawn,
    start: () => previewVoice(spawn, "maple", abort.signal),
  };
}

it("uses an ephemeral read-only seat and bundled input, then closes after the sample", async () => {
  const f = fixture();
  const playing = f.start();
  await vi.advanceTimersByTimeAsync(1500);
  await playing;
  expect(rpc.request).toHaveBeenCalledWith(
    "thread/start",
    expect.objectContaining({
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    }),
  );
  expect(vi.mocked(openVoice).mock.calls[0]?.[7]).toBe("maple");
  expect(vi.mocked(openVoice).mock.calls[0]?.[9]).toBe(f.context);
  expect(f.input).toHaveBeenCalledTimes(2);
  expect(vi.mocked(openVoice).mock.calls[0]?.[2].aborted).toBe(true);
  expect(f.close).toHaveBeenCalled();
  expect(rpc.close).toHaveBeenCalled();
});

it("stops a pending autoplay resume without starting Codex", async () => {
  const f = fixture(new Promise(() => {}));
  const playing = expect(f.start()).rejects.toThrow("stopped");
  f.abort.abort();
  await playing;
  expect(rpc.open).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalled();
});

it("times out stalled startup and releases playback", async () => {
  const f = fixture(new Promise(() => {}));
  const playing = expect(f.start()).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(30_000);
  await playing;
  expect(f.close).toHaveBeenCalled();
  expect(rpc.close).toHaveBeenCalled();
});
