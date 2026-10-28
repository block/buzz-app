/** canvas.toBlob off the main thread. WebKit's toBlob encodes on the calling
 * thread (about 18 ms per 640px JPEG video frame), so a shared worker encodes
 * a bitmap snapshot instead. Without worker canvases, or when the worker
 * cannot encode, the canvas encodes itself. */
let worker: Worker | undefined;
let unavailable = false;
let nextId = 0;
const requests = new Map<
  number,
  { callback: BlobCallback; inline: () => void }
>();

function encoder() {
  if (worker || unavailable) return worker;
  try {
    worker = new Worker(new URL("./canvas-blob.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    unavailable = true;
    return undefined;
  }
  worker.onmessage = (event: MessageEvent<{ id: number; blob?: Blob }>) => {
    const request = requests.get(event.data.id);
    requests.delete(event.data.id);
    if (event.data.blob) request?.callback(event.data.blob);
    else request?.inline();
  };
  worker.onerror = () => {
    unavailable = true;
    worker?.terminate();
    worker = undefined;
    const inline = [...requests.values()];
    requests.clear();
    for (const request of inline) request.inline();
  };
  return worker;
}

export function canvasBlob(
  canvas: HTMLCanvasElement,
  callback: BlobCallback,
  type: string,
  quality: number,
) {
  const inline = () => canvas.toBlob(callback, type, quality);
  if (
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap === "undefined" ||
    !encoder()
  )
    return inline();
  const id = nextId++;
  // Fallbacks run after canvasBlob returns, so a canvas that refuses export
  // (a cross-origin frame) reports no blob instead of throwing.
  const fallback = () => {
    try {
      inline();
    } catch {
      callback(null);
    }
  };
  const fail = () => {
    const request = requests.get(id);
    requests.delete(id);
    request?.inline();
  };
  requests.set(id, { callback, inline: fallback });
  createImageBitmap(canvas).then((bitmap) => {
    if (!worker || !requests.has(id)) return bitmap.close();
    try {
      worker.postMessage({ id, bitmap, type, quality }, [bitmap]);
    } catch {
      bitmap.close();
      fail();
    }
  }, fail);
}
