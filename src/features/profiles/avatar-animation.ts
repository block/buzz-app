import { pngChunks, webpChunks } from "../messages/image-metadata";
import { imageType, MIB } from "../relay/attachment-limits";

const MAX_BYTES = 16 * MIB;
const MAX_EDGE = 512;
const MAX_FRAMES = 128;
const MAX_FRAME_PIXELS = 16 * MIB;
const invalid = () =>
  new Error("Avatar animation exceeds playback limits or is malformed.");
const view = (b: Uint8Array) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength);
const u24 = (b: Uint8Array, at: number) => {
  if (at + 3 > b.length) throw invalid();
  return view(b).getUint16(at, true) + (b[at + 2] ?? 0) * 65536;
};

/** Inspect compressed containers before handing any bytes to an image decoder.
 * The frame-pixel budget estimates RGBA storage, not total decoder memory. */
export function avatarAnimationBlob(bytes: Uint8Array): Blob {
  if (!bytes.length || bytes.length > MAX_BYTES) throw invalid();
  const type = imageType(bytes);
  const v = view(bytes);
  let width = 0;
  let height = 0;
  let frames = 0;
  let poster = 0;
  function canvas(w: number, h: number) {
    if (!w || !h || w > MAX_EDGE || h > MAX_EDGE) throw invalid();
    width = w;
    height = h;
  }
  function frame(w: number, h: number, x = 0, y = 0) {
    if (!w || !h || x + w > width || y + h > height) throw invalid();
    if (++frames > MAX_FRAMES) throw invalid();
    if (width * height * (frames + poster) > MAX_FRAME_PIXELS) throw invalid();
  }
  if (type === "image/png") {
    const chunks = pngChunks(bytes);
    const head = chunks[0];
    if (head?.kind !== "IHDR" || head.payload.length !== 13) throw invalid();
    canvas(view(head.payload).getUint32(0), view(head.payload).getUint32(4));
    const controls = chunks.filter((c) => c.kind === "acTL");
    if (controls.length !== 1 || controls[0]?.payload.length !== 8)
      throw invalid();
    // Also budget a fallback poster, even when it is the first animation frame.
    poster = 1;
    for (const { kind, payload } of chunks) {
      if (kind !== "fcTL") continue;
      if (payload.length !== 26) throw invalid();
      const f = view(payload);
      frame(f.getUint32(4), f.getUint32(8), f.getUint32(12), f.getUint32(16));
    }
    if (view(controls[0].payload).getUint32(0) !== frames) throw invalid();
  } else if (type === "image/webp") {
    const chunks = webpChunks(bytes);
    const head = chunks[0];
    if (head?.kind !== "VP8X" || head.payload.length !== 10) throw invalid();
    if (!((head.payload[0] ?? 0) & 2)) throw invalid();
    canvas(u24(head.payload, 4) + 1, u24(head.payload, 7) + 1);
    for (const { kind, payload } of chunks) {
      if (kind !== "ANMF") continue;
      if (payload.length < 16) throw invalid();
      const w = u24(payload, 6) + 1;
      const h = u24(payload, 9) + 1;
      frame(w, h, u24(payload, 0) * 2, u24(payload, 3) * 2);
      // Check the encoded frame too: a small ANMF rectangle must not disguise
      // a larger VP8/VP8L image from the decoder.
      let images = 0;
      for (let at = 16; at < payload.length; ) {
        if (at + 8 > payload.length) throw invalid();
        const length = view(payload).getUint32(at + 4, true);
        const end = at + 8 + length;
        if (end + (length & 1) > payload.length) throw invalid();
        const kind = String.fromCharCode(...payload.subarray(at, at + 4));
        const data = payload.subarray(at + 8, end);
        if (kind === "VP8L") {
          if (data.length < 5 || data[0] !== 0x2f) throw invalid();
          const bits = view(data).getUint32(1, true);
          if ((bits & 0x3fff) + 1 !== w || ((bits >>> 14) & 0x3fff) + 1 !== h)
            throw invalid();
          images++;
        } else if (kind === "VP8 ") {
          if (
            data.length < 10 ||
            data[3] !== 0x9d ||
            data[4] !== 1 ||
            data[5] !== 0x2a
          )
            throw invalid();
          if (
            (view(data).getUint16(6, true) & 0x3fff) !== w ||
            (view(data).getUint16(8, true) & 0x3fff) !== h
          )
            throw invalid();
          images++;
        }
        at = end + (length & 1);
      }
      if (images !== 1) throw invalid();
    }
  } else if (type === "image/gif") {
    if (bytes.length < 13) throw invalid();
    canvas(v.getUint16(6, true), v.getUint16(8, true));
    const table = (packed: number) =>
      packed & 0x80 ? 3 << ((packed & 7) + 1) : 0;
    let at = 13 + table(bytes[10] ?? 0);
    let ended = false;
    while (at < bytes.length) {
      const block = bytes[at++];
      if (block === 0x3b) {
        ended = true;
        break;
      }
      if (block === 0x2c) {
        if (at + 9 > bytes.length) throw invalid();
        frame(
          v.getUint16(at + 4, true),
          v.getUint16(at + 6, true),
          v.getUint16(at, true),
          v.getUint16(at + 2, true),
        );
        at += 9 + table(bytes[at + 8] ?? 0);
        // The LZW minimum code size precedes the image sub-blocks.
        if (at >= bytes.length) throw invalid();
        at++;
      } else if (block === 0x21) {
        if (at >= bytes.length) throw invalid();
        at++;
      } else throw invalid();
      for (;;) {
        if (at >= bytes.length) throw invalid();
        const length = bytes[at++] ?? 0;
        if (!length) break;
        at += length;
        if (at > bytes.length) throw invalid();
      }
    }
    if (!ended) throw invalid();
  } else throw invalid();
  if (!frames) throw invalid();
  return new Blob([bytes.slice()], { type });
}

/** Fetch only through the caller's authenticated community media resolver.
 * Native custom-scheme requests may finish in the host after JS cancellation;
 * this budget bounds bytes admitted to the image decoder, not native traffic. */
export async function loadAvatarAnimation(source: string, signal: AbortSignal) {
  const response = await fetch(source, { signal });
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get("content-length")) > MAX_BYTES
  ) {
    await response.body?.cancel();
    throw invalid();
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BYTES) throw invalid();
      parts.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return avatarAnimationBlob(bytes);
}
