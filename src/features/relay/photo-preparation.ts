import {
  type AttachmentUpload,
  UPLOAD_MAX_BYTES,
  UploadError,
} from "./attachments";

const MAX_PIXELS = 25_000_000;
const PNG = "\x89PNG\r\n\x1a\n";
const text = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

export class PhotoPreparationError extends Error {
  constructor() {
    super(
      "This photo could not be prepared safely. Choose an exported JPEG or PNG copy, or remove it.",
    );
  }
}

function dimensions(width: number, height: number) {
  if (!width || !height || width * height > MAX_PIXELS)
    throw new PhotoPreparationError();
}

/** Container inspection is only for safe decode admission, not server acceptance. */
function inspect(bytes: Uint8Array):
  | {
      type: string;
      animated: boolean;
      snapshot?: Uint8Array<ArrayBuffer> | undefined;
    }
  | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (text(bytes, 0, 8) === PNG) {
    let offset = 8;
    let animated = false;
    let sawHeader = false;
    let snapshot: Uint8Array<ArrayBuffer> | undefined;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      const kind = text(bytes, offset + 4, 4);
      const end = offset + 12 + length;
      if (end > bytes.length) throw new PhotoPreparationError();
      if (!sawHeader) {
        if (kind !== "IHDR" || length !== 13) throw new PhotoPreparationError();
        dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12));
        sawHeader = true;
      }
      if (kind === "acTL") animated = true;
      if (
        kind === "tEXt" &&
        ["buzz_agent_snapshot\0", "buzz_team_snapshot\0"].some(
          (keyword) =>
            length > keyword.length &&
            text(bytes, offset + 8, keyword.length) === keyword,
        )
      ) {
        if (snapshot) throw new PhotoPreparationError();
        snapshot = bytes.slice(offset, end);
      }
      if (kind === "IEND") return { type: "image/png", animated, snapshot };
      offset = end;
    }
    throw new PhotoPreparationError();
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) throw new PhotoPreparationError();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length)
        throw new PhotoPreparationError();
      if (marker !== undefined && [0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) throw new PhotoPreparationError();
        dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
        return { type: "image/jpeg", animated: false };
      }
      offset += length;
    }
    throw new PhotoPreparationError();
  }
  if (text(bytes, 0, 4) === "RIFF" && text(bytes, 8, 4) === "WEBP") {
    if (bytes.length < 20 || view.getUint32(4, true) + 8 !== bytes.length)
      throw new PhotoPreparationError();
    let offset = 12;
    let animated = false;
    let sized = false;
    const u24 = (at: number) =>
      (bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16);
    while (offset + 8 <= bytes.length) {
      const kind = text(bytes, offset, 4);
      const length = view.getUint32(offset + 4, true);
      const start = offset + 8;
      const end = start + length + (length & 1);
      if (end > bytes.length) throw new PhotoPreparationError();
      if (kind === "VP8X" && length === 10) {
        dimensions(u24(start + 4) + 1, u24(start + 7) + 1);
        animated ||= ((bytes[start] ?? 0) & 2) !== 0;
        sized = true;
      } else if (kind === "VP8 " && length >= 10) {
        dimensions(
          view.getUint16(start + 6, true) & 0x3fff,
          view.getUint16(start + 8, true) & 0x3fff,
        );
        sized = true;
      } else if (kind === "VP8L" && length >= 5) {
        const bits = view.getUint32(start + 1, true);
        dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        sized = true;
      }
      if (kind === "ANIM" || kind === "ANMF") animated = true;
      offset = end;
    }
    if (!sized || offset !== bytes.length) throw new PhotoPreparationError();
    return { type: "image/webp", animated };
  }
  return undefined;
}

/** Canvas encoders may add a colour profile or resolution; the relay rejects both. */
function cleanEncoded(
  bytes: Uint8Array,
  type: string,
  snapshot?: Uint8Array<ArrayBuffer>,
): Blob {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  if (type === "image/png" && text(bytes, 0, 8) === PNG) {
    chunks.push(bytes.slice(0, 8));
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      const end = offset + 12 + length;
      const kind = text(bytes, offset + 4, 4);
      if (end > bytes.length) throw new PhotoPreparationError();
      if (
        [
          "IHDR",
          "PLTE",
          "IDAT",
          "IEND",
          "tRNS",
          "sRGB",
          "gAMA",
          "cHRM",
        ].includes(kind)
      )
        chunks.push(bytes.slice(offset, end));
      if (kind === "IHDR" && snapshot) chunks.push(snapshot);
      if (kind === "IEND") return new Blob(chunks, { type });
      offset = end;
    }
  } else if (type === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    chunks.push(bytes.slice(0, 2));
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) throw new PhotoPreparationError();
      const marker = bytes[offset + 1] ?? 0;
      // Only freshly encoded canvas output reaches this function, never source scan data.
      if (marker === 0xda) {
        chunks.push(bytes.slice(offset));
        return new Blob(chunks, { type });
      }
      const length = view.getUint16(offset + 2);
      const end = offset + 2 + length;
      if (length < 2 || end > bytes.length) throw new PhotoPreparationError();
      if (
        !(
          (marker >= 0xe1 && marker <= 0xed) ||
          marker === 0xef ||
          marker === 0xfe
        )
      )
        chunks.push(bytes.slice(offset, end));
      offset = end;
    }
  }
  throw new PhotoPreparationError();
}

/** Static photos only. Animation and other files retain the existing server-validated path. */
export async function preparePhoto(
  file: File,
  signal: AbortSignal,
): Promise<File> {
  signal.throwIfAborted();
  if (!file.size || file.size > UPLOAD_MAX_BYTES) throw new UploadError("size");
  const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  signal.throwIfAborted();
  if (
    !(signature[0] === 0xff && signature[1] === 0xd8) &&
    text(signature, 0, 8) !== PNG &&
    !(text(signature, 0, 4) === "RIFF" && text(signature, 8, 4) === "WEBP")
  )
    return file;
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  const photo = inspect(bytes);
  if (!photo || photo.animated) return file;
  let bitmap: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    // Ignore caller MIME hints. The browser applies EXIF orientation and colour conversion.
    bitmap = await createImageBitmap(new Blob([bytes], { type: photo.type }));
    signal.throwIfAborted();
    dimensions(bitmap.width, bitmap.height);
    canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { colorSpace: "srgb" });
    if (!context) throw new PhotoPreparationError();
    context.drawImage(bitmap, 0, 0);
    // PNG keeps alpha and avoids a second lossy WebP encoding; JPEG remains JPEG.
    const type = photo.type === "image/jpeg" ? "image/jpeg" : "image/png";
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas?.toBlob(resolve, type, 0.95),
    );
    signal.throwIfAborted();
    if (!blob || blob.type !== type) throw new PhotoPreparationError();
    const clean = cleanEncoded(
      new Uint8Array(await blob.arrayBuffer()),
      type,
      photo.snapshot,
    );
    signal.throwIfAborted();
    if (!clean.size || clean.size > UPLOAD_MAX_BYTES)
      throw new UploadError("size");
    const name =
      photo.type === "image/webp"
        ? `${file.name.replace(/\.[^.]*$/, "")}.png`
        : file.name;
    return new File([clean], name, { type });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof UploadError) throw error;
    throw new PhotoPreparationError();
  } finally {
    bitmap?.close();
    if (canvas) canvas.width = canvas.height = 0;
  }
}

export function withPhotoPreparation(
  upload: AttachmentUpload,
): AttachmentUpload {
  return async (file, signal) => {
    const prepared = await preparePhoto(file, signal);
    signal.throwIfAborted();
    return upload(prepared, signal);
  };
}
