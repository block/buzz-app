/** One worker per pixel conversion: cancellation terminates synchronous Wasm work. */
export function encodeWebp(
  pixels: ImageData,
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./webp-encoder.worker.ts", import.meta.url),
      { type: "module" },
    );
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const cleanup = () => {
      worker.terminate();
      bounded.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(bounded.reason);
    };
    bounded.addEventListener("abort", abort, { once: true });
    worker.onmessage = (
      event: MessageEvent<{ bytes?: ArrayBuffer; error?: string }>,
    ) => {
      cleanup();
      if (event.data.bytes)
        resolve(new Blob([event.data.bytes], { type: "image/webp" }));
      else reject(new Error(event.data.error || "WebP preparation failed."));
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error("WebP encoder could not load."));
    };
    try {
      worker.postMessage(pixels, [pixels.data.buffer]);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
