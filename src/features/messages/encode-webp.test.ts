import { afterEach, expect, it, vi } from "vitest";
import { encodeWebp } from "./encode-webp";

class EncoderWorker {
  static latest: EncoderWorker;
  constructor() {
    EncoderWorker.latest = this;
  }
  terminate = vi.fn();
  postMessage = vi.fn();
  onmessage?: (event: {
    data: { bytes?: ArrayBuffer; error?: string };
  }) => void;
  onerror?: () => void;
}
const pixels = () =>
  ({
    data: new Uint8ClampedArray(4),
    width: 1,
    height: 1,
    colorSpace: "srgb",
  }) as ImageData;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("terminates the worker on success and removes the abort listener", async () => {
  vi.stubGlobal("Worker", EncoderWorker);
  const controller = new AbortController();
  const image = pixels();
  const result = encodeWebp(image, controller.signal);
  const worker = EncoderWorker.latest;
  expect(worker.postMessage).toHaveBeenCalledWith(image, [image.data.buffer]);
  worker.onmessage?.({ data: { bytes: new Uint8Array([1, 2]).buffer } });
  expect((await result).type).toBe("image/webp");
  expect((await result).size).toBe(2);
  controller.abort();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
it.each(["cancel", "deadline", "load", "encode"])(
  "terminates failed work: %s",
  async (failure) => {
    vi.stubGlobal("Worker", EncoderWorker);
    const caller = new AbortController();
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const result = encodeWebp(pixels(), caller.signal);
    const rejected = expect(result).rejects.toThrow();
    const worker = EncoderWorker.latest;
    if (failure === "cancel") caller.abort();
    if (failure === "deadline") deadline.abort();
    if (failure === "load") worker.onerror?.();
    if (failure === "encode")
      worker.onmessage?.({ data: { error: "Encode failed" } });
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  },
);
it("terminates if transferring pixels throws", async () => {
  vi.stubGlobal(
    "Worker",
    class extends EncoderWorker {
      postMessage = vi.fn(() => {
        throw new Error("Clone failure");
      });
    },
  );
  await expect(
    encodeWebp(pixels(), new AbortController().signal),
  ).rejects.toThrow("Clone failure");
  expect(EncoderWorker.latest.terminate).toHaveBeenCalledTimes(1);
});
