import { afterEach, expect, it, vi } from "vitest";
import { canvasBlob } from "./canvas-blob";

class EncoderWorker {
  static latest: EncoderWorker;
  constructor() {
    EncoderWorker.latest = this;
  }
  terminate = vi.fn();
  postMessage = vi.fn();
  onmessage?: (event: { data: Blob | undefined }) => void;
  onerror?: () => void;
}
const fakeCanvas = () => ({ toBlob: vi.fn() }) as unknown as HTMLCanvasElement;
const settle = () => new Promise((resolve) => setTimeout(resolve));
function stubWorkerCanvas() {
  vi.stubGlobal("Worker", EncoderWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
  const bitmap = { close: vi.fn() };
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap),
  );
  return bitmap;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("encodes inline without worker canvases", () => {
  vi.stubGlobal("OffscreenCanvas", undefined);
  const canvas = fakeCanvas();
  const callback = vi.fn();
  canvasBlob(canvas, callback, "image/jpeg", 0.8);
  expect(canvas.toBlob).toHaveBeenCalledWith(callback, "image/jpeg", 0.8);
});

it("encodes a bitmap snapshot in a worker", async () => {
  const bitmap = stubWorkerCanvas();
  const canvas = fakeCanvas();
  const callback = vi.fn();
  canvasBlob(canvas, callback, "image/jpeg", 0.8);
  await settle();
  const worker = EncoderWorker.latest;
  expect(worker.postMessage).toHaveBeenCalledWith(
    { bitmap, type: "image/jpeg", quality: 0.8 },
    [bitmap],
  );
  const blob = new Blob(["frame"], { type: "image/jpeg" });
  worker.onmessage?.({ data: blob });
  expect(callback).toHaveBeenCalledWith(blob);
  expect(worker.terminate).toHaveBeenCalled();
  expect(canvas.toBlob).not.toHaveBeenCalled();
});

it.each([
  [
    "cannot encode",
    (worker: EncoderWorker) => worker.onmessage?.({ data: undefined }),
  ],
  ["cannot load", (worker: EncoderWorker) => worker.onerror?.()],
])("encodes inline when the worker %s", async (_, fail) => {
  stubWorkerCanvas();
  const canvas = fakeCanvas();
  const callback = vi.fn();
  canvasBlob(canvas, callback, "image/jpeg", 0.8);
  await settle();
  fail(EncoderWorker.latest);
  expect(EncoderWorker.latest.terminate).toHaveBeenCalled();
  expect(canvas.toBlob).toHaveBeenCalledWith(callback, "image/jpeg", 0.8);
  expect(callback).not.toHaveBeenCalled();
});
