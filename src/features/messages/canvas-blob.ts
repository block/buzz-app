/** canvas.toBlob off the main thread. WebKit's toBlob encodes on the calling
 * thread (about 18 ms per 640px JPEG video frame), so a worker encodes a
 * bitmap snapshot instead. Without worker canvases, or when the worker cannot
 * encode, the canvas encodes itself. */
export function canvasBlob(
  canvas: HTMLCanvasElement,
  callback: BlobCallback,
  type: string,
  quality: number,
) {
  const inline = () => canvas.toBlob(callback, type, quality);
  if (
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap === "undefined"
  )
    return inline();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./canvas-blob.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    return inline();
  }
  const finish = (blob?: Blob) => {
    worker.terminate();
    if (blob) callback(blob);
    else inline();
  };
  worker.onmessage = (event: MessageEvent<Blob | undefined>) =>
    finish(event.data);
  worker.onerror = () => finish();
  createImageBitmap(canvas).then(
    (bitmap) => worker.postMessage({ bitmap, type, quality }, [bitmap]),
    () => finish(),
  );
}
