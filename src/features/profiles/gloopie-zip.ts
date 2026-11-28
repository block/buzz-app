import { videoDemuxer } from "../relay/video-preparation";

export type GloopieParts = { poster: File; animation: File };

const NOT_GLOOPIE =
  "This ZIP isn't an animated Gloopie. It needs one PNG and one WebM.";
const TOO_LARGE = "This ZIP is too large for an avatar.";
const UNSUPPORTED = "This ZIP uses a format this app can't open.";
const DAMAGED = "This ZIP is damaged. Download it again.";

const MIB = 1024 * 1024;

type Entry = {
  flags: number;
  method: number;
  csize: number;
  usize: number;
  offset: number;
};

/** An animated Gloopie's ZIP: its PNG poster and VP9-alpha WebM. The MP4 has no
 * alpha and is never read. Undefined for anything that isn't a ZIP. Entry
 * names only pick the two parts, never a path. */
export async function readGloopieZip(
  file: File,
  signal: AbortSignal,
): Promise<GloopieParts | undefined> {
  const read = async (start: number, end: number) => {
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    signal.throwIfAborted();
    return bytes;
  };
  const head = await read(0, 4);
  if (head.length < 4 || le(head).getUint32(0, true) !== 0x04034b50) return;
  if (file.size > 128 * MIB) throw new Error(TOO_LARGE);

  const tailStart = Math.max(0, file.size - 22 - 65535);
  const tail = await read(tailStart, file.size);
  const end = le(tail);
  let eocd = tail.length - 22;
  while (eocd >= 0 && end.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error(DAMAGED);
  const entries = end.getUint16(eocd + 10, true);
  const cdSize = end.getUint32(eocd + 12, true);
  const cdOffset = end.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new Error(UNSUPPORTED);
  if (entries > 16) throw new Error(NOT_GLOOPIE);
  if (cdOffset + cdSize > tailStart + eocd) throw new Error(DAMAGED);

  const cd = await read(cdOffset, cdOffset + cdSize);
  const records = le(cd);
  const names = new TextDecoder();
  const pngs: Entry[] = [];
  const webms: Entry[] = [];
  for (let index = 0, at = 0; index < entries; index++) {
    if (at + 46 > cd.length || records.getUint32(at, true) !== 0x02014b50)
      throw new Error(DAMAGED);
    const nameEnd = at + 46 + records.getUint16(at + 28, true);
    const next =
      nameEnd +
      records.getUint16(at + 30, true) +
      records.getUint16(at + 32, true);
    if (next > cd.length) throw new Error(DAMAGED);
    const name = names.decode(cd.subarray(at + 46, nameEnd));
    const entry = {
      flags: records.getUint16(at + 8, true),
      method: records.getUint16(at + 10, true),
      csize: records.getUint32(at + 20, true),
      usize: records.getUint32(at + 24, true),
      offset: records.getUint32(at + 42, true),
    };
    at = next;
    // Folders and the resource forks macOS adds when it zips.
    const base = name.slice(name.lastIndexOf("/") + 1);
    if (name.endsWith("/") || name.startsWith("__MACOSX/")) continue;
    if (base.startsWith("._")) continue;
    if (/\.png$/i.test(name)) pngs.push(entry);
    else if (/\.webm$/i.test(name)) webms.push(entry);
  }
  const [pngEntry] = pngs;
  const [webmEntry] = webms;
  if (pngs.length !== 1 || webms.length !== 1 || !pngEntry || !webmEntry)
    throw new Error(NOT_GLOOPIE);

  const extract = async (entry: Entry, cap: number): Promise<Blob> => {
    if (entry.flags & 1) throw new Error(UNSUPPORTED);
    if (entry.usize > cap) throw new Error(TOO_LARGE);
    const local = le(await read(entry.offset, entry.offset + 30));
    if (local.byteLength < 30 || local.getUint32(0, true) !== 0x04034b50)
      throw new Error(DAMAGED);
    const start =
      entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    const stop = start + entry.csize;
    if (stop > file.size) throw new Error(DAMAGED);
    if (entry.method === 0) {
      if (entry.csize !== entry.usize) throw new Error(DAMAGED);
      return file.slice(start, stop);
    }
    if (entry.method !== 8 || typeof DecompressionStream === "undefined")
      throw new Error(UNSUPPORTED);
    const reader = file
      .slice(start, stop)
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"))
      .getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > entry.usize) throw new Error(DAMAGED);
        chunks.push(value);
      }
    } catch {
      void reader.cancel().catch(() => {});
      signal.throwIfAborted();
      throw new Error(DAMAGED);
    }
    signal.throwIfAborted();
    if (total !== entry.usize) throw new Error(DAMAGED);
    return new Blob(chunks);
  };
  const png = await extract(pngEntry, 50 * MIB);
  const webm = await extract(webmEntry, 64 * MIB);

  const pngHead = new Uint8Array(await png.slice(0, 8).arrayBuffer());
  const webmHead = new Uint8Array(await webm.slice(0, 4096).arrayBuffer());
  signal.throwIfAborted();
  if (
    !pngSignature.every((byte, index) => pngHead[index] === byte) ||
    videoDemuxer(webmHead) !== "matroska"
  )
    throw new Error(NOT_GLOOPIE);
  return {
    poster: new File([png], "avatar.png", { type: "image/png" }),
    animation: new File([webm], "avatar.webm", { type: "video/webm" }),
  };
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const le = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
