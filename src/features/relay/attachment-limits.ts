/** Old Buzz relay defaults. The relay may enforce a lower deployment policy. */
export const MIB = 1024 * 1024;
export const UPLOAD_MAX_BYTES = 500 * MIB;
export const UPLOAD_TIMEOUT_MS = 600_000;
export function mediaByteLimit(type: string): number {
  if (type === "image/gif") return 10 * MIB;
  if (type.startsWith("image/")) return 50 * MIB;
  if (type.startsWith("video/")) return UPLOAD_MAX_BYTES;
  return 100 * MIB;
}
/** MIME hints never grant acceptance: the relay still sniffs and validates content. */
export function imageType(bytes: Uint8Array): string | undefined {
  const text = (a: number, b: number) =>
    String.fromCharCode(...bytes.subarray(a, b));
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (text(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (/^GIF8[79]a$/.test(text(0, 6))) return "image/gif";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  return undefined;
}
