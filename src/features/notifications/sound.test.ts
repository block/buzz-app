import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isSoundName } from "./sound";

const decoded = {} as AudioBuffer;
const sources: Array<{
  buffer: unknown;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}> = [];
let resume: ReturnType<typeof vi.fn>;
let decode: ReturnType<typeof vi.fn>;
let fetchSound: ReturnType<typeof vi.fn>;
let sound: typeof import("./sound");

beforeEach(async () => {
  vi.resetModules();
  sources.length = 0;
  resume = vi.fn(async () => {});
  decode = vi.fn(async () => decoded);
  fetchSound = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(1),
  }));
  vi.stubGlobal("fetch", fetchSound);
  vi.stubGlobal(
    "Audio",
    vi.fn(() => {
      throw new Error("Must not create a media element");
    }),
  );
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "suspended";
      destination = {};
      resume = resume;
      decodeAudioData = decode;
      createBufferSource() {
        const source = {
          buffer: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null,
        };
        sources.push(source);
        return source;
      }
    },
  );
  sound = await import("./sound");
});
afterEach(() => vi.unstubAllGlobals());

async function started(count: number) {
  await vi.waitFor(() => expect(sources).toHaveLength(count));
}

it("plays decoded effects without creating a media element, and reuses the buffer", async () => {
  const first = sound.playNotificationSound("ping");
  expect(resume).toHaveBeenCalledOnce();
  await started(1);
  expect(fetchSound).toHaveBeenCalledWith("/sounds/ping.mp3");
  expect(sources[0]?.buffer).toBe(decoded);
  expect(sources[0]?.start).toHaveBeenCalledOnce();
  const second = sound.playNotificationSound("ping");
  await started(2);
  expect(sources[0]?.stop).toHaveBeenCalledOnce();
  expect(sources[0]?.disconnect).toHaveBeenCalledOnce();
  expect(fetchSound).toHaveBeenCalledOnce();
  expect(Audio).not.toHaveBeenCalled();
  sources[1]?.onended?.();
  await second?.finished;
  await first?.finished;
  expect(sources[1]?.disconnect).toHaveBeenCalledOnce();
});

it("cancels during loading without playing a late decoded preview", async () => {
  let release!: (value: AudioBuffer) => void;
  decode.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const preview = sound.playSoundEffect("boo");
  await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
  preview?.stop();
  release(decoded);
  await preview?.finished;
  await Promise.resolve();
  expect(sources).toHaveLength(0);
});

it("keeps different effects independent and stops a preview idempotently", async () => {
  const first = sound.playSoundEffect("boo");
  const second = sound.playNotificationSound("ping");
  await started(2);
  first?.stop();
  first?.stop();
  expect(sources[0]?.stop).toHaveBeenCalledOnce();
  expect(sources[1]?.stop).not.toHaveBeenCalled();
  second?.stop();
});

it("retries failed loads and quietly finishes failed playback", async () => {
  fetchSound.mockResolvedValueOnce({ ok: false });
  await sound.playNotificationSound("doo")?.finished;
  sound.playNotificationSound("doo");
  await started(1);
  expect(fetchSound).toHaveBeenCalledTimes(2);
  resume.mockRejectedValueOnce(new Error("Blocked"));
  await sound.playSoundEffect("soft")?.finished;
  expect(sources).toHaveLength(1);
});

it("Silent and hosts without Web Audio are quiet", () => {
  expect(isSoundName("silent")).toBe(true);
  expect(sound.playNotificationSound("silent")).toBeNull();
  vi.stubGlobal("AudioContext", undefined);
  expect(sound.playNotificationSound("doong")).toBeNull();
  expect(fetchSound).not.toHaveBeenCalled();
});

it("only starts the latest notification when repeated during a load", async () => {
  let release!: (value: AudioBuffer) => void;
  decode.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = sound.playNotificationSound("ping");
  await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
  const second = sound.playNotificationSound("ping");
  release(decoded);
  await first?.finished;
  await started(1);
  expect(fetchSound).toHaveBeenCalledOnce();
  second?.stop();
});

it("can retry decoding failures without leaving an active notification", async () => {
  decode.mockRejectedValueOnce(new Error("Invalid MP3"));
  await sound.playNotificationSound("ping")?.finished;
  sound.playNotificationSound("ping");
  await started(1);
  expect(fetchSound).toHaveBeenCalledTimes(2);
});
