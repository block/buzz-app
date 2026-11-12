import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Sound = typeof import("./sound");
let sound: Sound;

beforeEach(async () => {
  // The output context and decoded clips are module state; isolate each test.
  vi.resetModules();
  sound = await import("./sound");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function settle() {
  // Let the fetch, decode, and resume chains finish.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function stubAudioContext() {
  const sources: Array<{
    buffer: unknown;
    onended: (() => void) | null;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const contexts: FakeContext[] = [];
  class FakeContext {
    state: AudioContextState = "running";
    destination = {};
    decodeAudioData = vi.fn(async (data: ArrayBuffer) => ({ decoded: data }));
    resume = vi.fn(async () => {});
    suspend = vi.fn(async () => {});
    createBufferSource = vi.fn(() => {
      const source = {
        buffer: null as unknown,
        onended: null as (() => void) | null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        // Like Web Audio, stopping a started source fires its ended event.
        stop: vi.fn(() => source.onended?.()),
      };
      sources.push(source);
      return source;
    });
    constructor() {
      contexts.push(this);
    }
  }
  vi.stubGlobal("AudioContext", FakeContext);
  return { contexts, sources };
}

function stubFetch(ok = () => true) {
  const fetch = vi.fn(async (url: string) => ({
    ok: ok(),
    status: ok() ? 200 : 404,
    arrayBuffer: async () => url,
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("playback without an AudioContext stays best-effort and never throws", () => {
  // Bare Node has no AudioContext global; delivery sound stays best-effort.
  expect(() => sound.playNotificationSound("doong")).not.toThrow();
});

it("plays bundled clips through Web Audio, never a Now Playing media element", async () => {
  const audio = vi.fn();
  vi.stubGlobal("Audio", audio);
  const { contexts, sources } = stubAudioContext();
  const fetch = stubFetch();
  sound.playNotificationSound("ping");
  await settle();
  expect(audio).not.toHaveBeenCalled();
  expect(contexts).toHaveLength(1);
  const [context] = contexts;
  expect(fetch).toHaveBeenCalledWith("/sounds/ping.mp3");
  expect(context?.resume).toHaveBeenCalledOnce();
  expect(sources[0]?.buffer).toEqual({ decoded: "/sounds/ping.mp3" });
  expect(sources[0]?.connect).toHaveBeenCalledWith(context?.destination);
  expect(sources[0]?.start).toHaveBeenCalledOnce();

  // A repeat reuses the context and the decoded clip.
  sound.playNotificationSound("ping");
  await settle();
  expect(contexts).toHaveLength(1);
  expect(fetch).toHaveBeenCalledOnce();
  expect(context?.decodeAudioData).toHaveBeenCalledOnce();
  expect(sources).toHaveLength(2);

  // The output suspends only after the last overlapping alert ends.
  sources[0]?.onended?.();
  expect(sources[0]?.disconnect).toHaveBeenCalledOnce();
  expect(context?.suspend).not.toHaveBeenCalled();
  sources[1]?.onended?.();
  expect(context?.suspend).toHaveBeenCalledOnce();
});

it("retries a clip whose load failed", async () => {
  const { contexts, sources } = stubAudioContext();
  let available = false;
  const fetch = stubFetch(() => available);
  sound.playNotificationSound("boo");
  await settle();
  expect(sources).toHaveLength(0);
  expect(contexts[0]?.suspend).toHaveBeenCalledOnce();
  available = true;
  sound.playNotificationSound("boo");
  await settle();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(sources[0]?.start).toHaveBeenCalledOnce();
});

it("reports a natural end or a failed load once, and never after a stop", async () => {
  const { contexts, sources } = stubAudioContext();
  let available = true;
  stubFetch(() => available);
  const ended = vi.fn();
  const stop = sound.playNotificationSound("ping", ended);
  await settle();
  sources[0]?.onended?.();
  expect(ended).toHaveBeenCalledOnce();
  stop();
  expect(ended).toHaveBeenCalledOnce();

  const stopped = vi.fn();
  const stopPlaying = sound.playNotificationSound("ping", stopped);
  await settle();
  stopPlaying();
  expect(sources[1]?.stop).toHaveBeenCalledOnce();
  expect(stopped).not.toHaveBeenCalled();
  expect(contexts[0]?.suspend).toHaveBeenCalledTimes(2);

  available = false;
  const failed = vi.fn();
  sound.playNotificationSound("boo", failed);
  await settle();
  expect(failed).toHaveBeenCalledOnce();
});

it("a stop before the clip loads never starts it and still releases the output", async () => {
  const { contexts, sources } = stubAudioContext();
  stubFetch();
  const ended = vi.fn();
  const stop = sound.playNotificationSound("ping", ended);
  stop();
  await settle();
  expect(sources).toHaveLength(0);
  expect(ended).not.toHaveBeenCalled();
  expect(contexts[0]?.suspend).toHaveBeenCalledOnce();
});

it("replaces a closed output context", async () => {
  const { contexts, sources } = stubAudioContext();
  stubFetch();
  sound.playNotificationSound("ping");
  await settle();
  sources[0]?.onended?.();
  if (contexts[0]) contexts[0].state = "closed";
  sound.playNotificationSound("ping");
  await settle();
  expect(contexts).toHaveLength(2);
  expect(sources[1]?.start).toHaveBeenCalledOnce();
});

it("Silent is valid and never creates or plays an audio asset", () => {
  const { contexts } = stubAudioContext();
  const fetch = stubFetch();
  expect(sound.isSoundName("silent")).toBe(true);
  sound.playNotificationSound("silent");
  expect(contexts).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("recognizes every bundled sound name", () => {
  for (const name of sound.SOUND_NAMES)
    expect(sound.isSoundName(name)).toBe(true);
  expect(sound.isSoundName("missing")).toBe(false);
});
