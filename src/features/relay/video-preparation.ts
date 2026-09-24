export const VIDEO_PREPARATION_MS = 600_000;

/** Container bytes choose a fixed demuxer, never a caller-supplied ffmpeg argument. */
export function videoDemuxer(bytes: Uint8Array): string | undefined {
  const text = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (text(0, 4) === "RIFF" && text(8, 12) === "AVI ") return "avi";
  if (text(0, 4) === "\x1a\x45\xdf\xa3") return "matroska";
  if (text(0, 3) === "FLV") return "flv";
  if (text(0, 10) === "\x30\x26\xb2\x75\x8e\x66\xcf\x11\xa6\xd9") return "asf";
  if (text(0, 3) === "\x00\x00\x01" && bytes[3] !== undefined) {
    const code = bytes[3];
    if (code >= 0xba && code <= 0xbf) return "mpeg";
    if (code === 0xb0 || code === 0xb1 || code === 0xb5 || code === 0xb6)
      return "m4v";
    if (code >= 0xb2 && code <= 0xb9) return "mpegvideo";
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 12 <= bytes.length; ) {
    const kind = text(offset + 4, offset + 8);
    if (kind === "ftyp") {
      // HEIF/AVIF stills are not videos, despite sharing an ISO-BMFF container.
      const end = Math.min(bytes.length, offset + view.getUint32(offset));
      for (
        let brand = offset + 8;
        brand + 4 <= end;
        brand += brand === offset + 8 ? 8 : 4
      )
        if (
          /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis)$/.test(
            text(brand, brand + 4),
          )
        )
          return undefined;
      // Old Buzz's byte sniffer recognizes these video brands, not arbitrary BMFF.
      // In particular M4A/M4B audio and unknown brands must not become videos.
      const brand = text(offset + 8, offset + 12);
      return /^(qt {2}|M4V.|avc1|dash|iso[2-6m]|mmp4|mp4[12v]|mp71|MSNV|NDAS|NDS[CHMPS]|NSDC|NDX[CHMPS]|F4[VP] )$/.test(
        brand,
      )
        ? "mov"
        : undefined;
    }
    if (["moov", "mdat"].includes(kind)) return "mov";
    if (!["wide", "free", "skip"].includes(kind)) break;
    const size = view.getUint32(offset);
    if (size < 8) break;
    offset += size;
  }
  return undefined;
}

/** Match old Buzz's HEIF brands, plus the filename fallback for unfamiliar brands. */
export function isHeic(bytes: Uint8Array, name = ""): boolean {
  if (/\.hei[cf]$/i.test(name)) return true;
  const text = (a: number, b: number) =>
    String.fromCharCode(...bytes.subarray(a, b));
  if (text(4, 8) !== "ftyp") return false;
  for (let offset = 8; offset + 4 <= Math.min(bytes.length, 32); offset += 4)
    if (
      /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(
        text(offset, offset + 4),
      )
    )
      return true;
  return false;
}

export function isVoiceNote(name: string): boolean {
  return /^voice-note-.*\.wav$/i.test(name);
}
/** Fixed audio demuxers for the old voice-note filename exception, not generic audio uploads. */
export function audioDemuxer(bytes: Uint8Array): string | undefined {
  const text = (a: number, b: number) =>
    String.fromCharCode(...bytes.subarray(a, b));
  if (text(0, 4) === "RIFF" && text(8, 12) === "WAVE") return "wav";
  if (text(0, 4) === "fLaC") return "flac";
  if (text(0, 4) === "OggS") return "ogg";
  if (text(0, 4) === "FORM" && ["AIFF", "AIFC"].includes(text(8, 12)))
    return "aiff";
  if (
    text(0, 3) === "ID3" ||
    (bytes[0] === 0xff &&
      ((bytes[1] ?? 0) & 0xe0) === 0xe0 &&
      ((bytes[1] ?? 0) & 6) !== 0)
  )
    return "mp3";
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0) return "aac";
  if (text(4, 8) === "ftyp" && /^(M4A |M4B |F4A |F4B )$/.test(text(8, 12)))
    return "mov";
  if (text(0, 5) === "#!AMR") return "amr";
  return undefined;
}
