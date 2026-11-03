/** The type and extension the relay stores an attachment under, decided as
 * the relay decides it: by sniffing the bytes (the `infer` crate's matchers,
 * in its order), never by the declared type. Only the first 4096 bytes are
 * needed; a file whose type depends on later bytes is reported unsupported. */

export const SNIFF_BYTES = 4096;

export const UNSUPPORTED_FILE =
  "This file type cannot be imported as an attachment.";

/** Sniffed types the relay stores, with their extensions. Unsniffable files
 * (plain text, CSV, JSON) are stored as `application/octet-stream` and `bin`. */
export const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/rtf": "rtf",
  "application/epub+zip": "epub",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "application/x-7z-compressed": "7z",
  "application/vnd.rar": "rar",
  "application/x-bzip2": "bz2",
  "application/x-xz": "xz",
  "application/zstd": "zst",
  "text/html": "html",
};

const IMAGE_PATH = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const UNKNOWN = Symbol("unknown");

/** A file prefix that reads as the whole file's length; reading past the
 * prefix means the answer depends on bytes we do not have. */
type Bytes = { readonly length: number; at(index: number): number };

function bytes(head: Uint8Array, length: number, offset = 0): Bytes {
  return {
    length: Math.max(0, length - offset),
    at(index) {
      const i = index + offset;
      if (i < head.length) return head[i] as number;
      throw UNKNOWN;
    },
  };
}

const slice = (buf: Bytes, start: number): Bytes => ({
  length: Math.max(0, buf.length - start),
  at: (index) => buf.at(index + start),
});

/** `compare_bytes`: in range and equal, read in order. */
function eq(buf: Bytes, offset: number, expected: string | readonly number[]) {
  const values =
    typeof expected === "string"
      ? [...expected].map((char) => char.charCodeAt(0))
      : expected;
  if (buf.length < offset + values.length) return false;
  return values.every((value, i) => buf.at(offset + i) === value);
}

const u32le = (buf: Bytes, at: number) =>
  (buf.at(at) |
    (buf.at(at + 1) << 8) |
    (buf.at(at + 2) << 16) |
    (buf.at(at + 3) << 24)) >>>
  0;
const u32be = (buf: Bytes, at: number) =>
  ((buf.at(at) << 24) |
    (buf.at(at + 1) << 16) |
    (buf.at(at + 2) << 8) |
    buf.at(at + 3)) >>>
  0;

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function zipSearch(buf: Bytes, start: number, range: number) {
  const end = Math.min(start + range, buf.length);
  for (let i = start; i + 4 <= end; i++) if (eq(buf, i, ZIP)) return i - start;
  return undefined;
}

function ooxmlFolder(buf: Bytes, offset: number) {
  if (eq(buf, offset, "word/")) return "docx";
  if (eq(buf, offset, "ppt/")) return "pptx";
  if (eq(buf, offset, "xl/")) return "xlsx";
  return undefined;
}

function msooxml(buf: Bytes) {
  if (!eq(buf, 0, ZIP)) return undefined;
  const first = ooxmlFolder(buf, 0x1e);
  if (first) return first;
  if (
    !eq(buf, 0x1e, "[Content_Types].xml") &&
    !eq(buf, 0x1e, "_rels/.rels") &&
    !eq(buf, 0x1e, "docProps")
  )
    return undefined;
  let start = u32le(buf, 18) + 49;
  if (start > 0xffffffff) return undefined;
  let index = zipSearch(buf, start, 6000);
  if (index === undefined) return undefined;
  start += index + 4 + 26;
  index = zipSearch(buf, start, 6000);
  if (index === undefined) return undefined;
  start += index + 4 + 26;
  if (!ooxmlFolder(buf, start)) return undefined;
  start += 26;
  index = zipSearch(buf, start, 6000);
  if (index === undefined) return "ooxml";
  start += index + 4 + 26;
  return ooxmlFolder(buf, start) ?? "ooxml";
}

/** The root storage CLSID of a compound file, read where the header places
 * the first directory sector. */
function ole2(buf: Bytes) {
  if (!eq(buf, 0, OLE)) return undefined;
  const shift = buf.at(0x1e) | (buf.at(0x1f) << 8);
  if (shift !== 9 && shift !== 12) return undefined;
  const sector = u32le(buf, 0x30);
  const entry = (sector + 1) * 2 ** shift;
  if (!Number.isSafeInteger(entry) || buf.length < entry + 128)
    return undefined;
  if (buf.at(entry + 0x42) !== 5) return undefined;
  const hex = (from: number, count: number, reverse: boolean) => {
    const out: string[] = [];
    for (let i = 0; i < count; i++)
      out.push(
        buf
          .at(entry + 0x50 + from + i)
          .toString(16)
          .padStart(2, "0"),
      );
    return (reverse ? out.reverse() : out).join("");
  };
  const clsid = `${hex(0, 4, true)}-${hex(4, 2, true)}-${hex(6, 2, true)}-${hex(8, 2, false)}-${hex(10, 6, false)}`;
  if (
    clsid === "00020810-0000-0000-c000-000000000046" ||
    clsid === "00020820-0000-0000-c000-000000000046"
  )
    return "xls";
  if (clsid === "00020906-0000-0000-c000-000000000046") return "doc";
  if (clsid === "64818d10-4f9b-11cf-86ea-00aa00b929e8") return "ppt";
  return undefined;
}

function skippableFrames(buf: Bytes, magic: (buf: Bytes) => boolean): boolean {
  if (magic(buf)) return true;
  if (buf.length < 8) return false;
  if ((u32le(buf, 0) & 0xfffffff0) >>> 0 !== 0x184d2a50) return false;
  const length = u32le(buf, 4);
  if (buf.length < 8 + length) return false;
  return skippableFrames(slice(buf, 8 + length), magic);
}

function trimmed(buf: Bytes) {
  let start = 0;
  while (start < buf.length && [9, 10, 12, 13, 32].includes(buf.at(start)))
    start++;
  return slice(buf, start);
}

function startsWithIgnoreCase(buf: Bytes, needle: string) {
  if (buf.length < needle.length) return false;
  for (let i = 0; i < needle.length; i++) {
    const a = buf.at(i);
    const lower = a >= 0x41 && a <= 0x5a ? a + 32 : a;
    if (lower !== needle.toLowerCase().charCodeAt(i)) return false;
  }
  return true;
}

const HTML = [
  "<!DOCTYPE HTML",
  "<HTML",
  "<HEAD",
  "<SCRIPT",
  "<IFRAME",
  "<H1",
  "<DIV",
  "<FONT",
  "<TABLE",
  "<A",
  "<STYLE",
  "<TITLE",
  "<B",
  "<BODY",
  "<BR",
  "<P",
  "<!--",
];

function isoBmffPayload(buf: Bytes): [number, number] | undefined {
  if (buf.length < 16 || !eq(buf, 4, "ftyp")) return undefined;
  const compact = u32be(buf, 0);
  let declared: number;
  let header: number;
  if (compact === 1) {
    if (buf.length < 24) return undefined;
    declared = u32be(buf, 8) * 2 ** 32 + u32be(buf, 12);
    header = 16;
  } else if (compact === 0) {
    declared = buf.length;
    header = 8;
  } else {
    declared = compact;
    header = 8;
  }
  if (declared < header + 8) return undefined;
  const end = Math.min(declared, buf.length);
  return end >= header + 8 ? [header, end] : undefined;
}

const MP4_BRANDS = [
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "iso7",
  "iso8",
  "iso9",
  "mp41",
  "mp42",
  "avc1",
  "dash",
  "M4V ",
];

function looksLikeMp4(buf: Bytes) {
  const payload = isoBmffPayload(buf);
  if (!payload) return false;
  const [start, end] = payload;
  if (MP4_BRANDS.some((brand) => eq(buf, start, brand))) return true;
  for (let at = start + 8; at + 4 <= end; at += 4)
    if (MP4_BRANDS.some((brand) => eq(buf, at, brand))) return true;
  return false;
}

const MP4_FTYP = [
  "avc1",
  "dash",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "isom",
  "mmp4",
  "mp41",
  "mp42",
  "mp4v",
  "mp71",
  "MSNV",
  "NDAS",
  "NDSC",
  "NSDC",
  "NDSH",
  "NDSM",
  "NDSP",
  "NDSS",
  "NDXC",
  "NDXH",
  "NDXM",
  "NDXP",
  "NDXS",
  "F4V ",
  "F4P ",
];

function ftypBrands(buf: Bytes) {
  if (buf.length < 16 || !eq(buf, 4, "ftyp")) return undefined;
  const length = u32be(buf, 0);
  if (buf.length < length) return undefined;
  const brands: string[] = [];
  const count = Math.max(0, Math.floor(length / 4) - 4);
  for (let i = 0; i < count && 16 + i * 4 + 4 <= buf.length; i++)
    brands.push(
      String.fromCharCode(
        buf.at(16 + i * 4),
        buf.at(17 + i * 4),
        buf.at(18 + i * 4),
        buf.at(19 + i * 4),
      ),
    );
  const major = String.fromCharCode(
    buf.at(8),
    buf.at(9),
    buf.at(10),
    buf.at(11),
  );
  return { major, brands };
}

const is =
  (length: number, offset: number, expected: string | number[]) =>
  (buf: Bytes) =>
    buf.length > length && eq(buf, offset, expected);

/** `infer::get`'s matchers in its order. */
const MATCHERS: readonly (readonly [string, (buf: Bytes) => boolean])[] = [
  [
    "application/wasm",
    (b) => b.length >= 8 && eq(b, 0, [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
  ],
  ["application/x-executable", is(52, 0, [0x7f, 0x45, 0x4c, 0x46])],
  ["application/vnd.microsoft.portable-executable", is(1, 0, "MZ")],
  [
    "application/java",
    (b) =>
      b.length >= 8 &&
      eq(b, 0, [0xca, 0xfe, 0xba, 0xbe]) &&
      u32be(b, 4) >= 45 &&
      ((b.at(6) << 8) | b.at(7)) >= 45,
  ],
  ["application/x-llvm", (b) => b.length >= 2 && eq(b, 0, "BC")],
  [
    "application/x-mach-binary",
    (b) => {
      if (b.length < 4) return false;
      const [w, x, y, z] = [b.at(0), b.at(1), b.at(2), b.at(3)];
      if ((w === 0xcf || w === 0xce) && x === 0xfa && y === 0xed && z === 0xfe)
        return true;
      if (w === 0xfe && x === 0xed && y === 0xfa && (z === 0xcf || z === 0xce))
        return true;
      return (
        w === 0xca &&
        x === 0xfe &&
        y === 0xba &&
        z === 0xbe &&
        b.length >= 8 &&
        u32be(b, 4) < 45
      );
    },
  ],
  [
    "application/vnd.android.dex",
    (b) => b.length > 36 && eq(b, 0, "dex\n") && b.at(36) === 0x70,
  ],
  [
    "application/vnd.android.dey",
    (b) =>
      b.length > 100 &&
      eq(b, 0, "dey\n") &&
      (() => {
        const inner: Bytes = { length: 60, at: (i) => b.at(40 + i) };
        return (
          inner.length > 36 && eq(inner, 0, "dex\n") && inner.at(36) === 0x70
        );
      })(),
  ],
  ["application/x-x509-ca-cert", is(2, 0, [0x30, 0x82])],
  [
    "application/x-executable",
    (b) =>
      b.length > 2 &&
      (eq(b, 0, [0x64, 0x86]) ||
        eq(b, 0, [0x4c, 0x01]) ||
        eq(b, 0, [0x00, 0x02])),
  ],
  ["application/x-x509-ca-cert", is(11, 0, "-----BEGIN ")],
  [
    "application/epub+zip",
    (b) =>
      b.length > 57 &&
      eq(b, 0, ZIP) &&
      eq(b, 30, "mimetypeapplication/epub+zip"),
  ],
  [
    "application/x-mobipocket-ebook",
    (b) => b.length > 67 && eq(b, 60, "BOOKMOBI"),
  ],
  ["image/jpeg", is(2, 0, [0xff, 0xd8, 0xff])],
  [
    "image/jp2",
    is(12, 0, [0, 0, 0, 0xc, 0x6a, 0x50, 0x20, 0x20, 0xd, 0xa, 0x87, 0xa, 0]),
  ],
  ["image/png", is(3, 0, [0x89, 0x50, 0x4e, 0x47])],
  ["image/gif", is(2, 0, "GIF")],
  ["image/webp", is(11, 8, "WEBP")],
  [
    "image/x-canon-cr2",
    (b) =>
      b.length > 10 &&
      (eq(b, 0, [0x49, 0x49, 0x2a, 0]) || eq(b, 0, [0x4d, 0x4d, 0, 0x2a])) &&
      eq(b, 8, [0x43, 0x52, 0x02]),
  ],
  [
    "image/tiff",
    (b) =>
      b.length > 9 &&
      (eq(b, 0, [0x49, 0x49, 0x2a, 0]) || eq(b, 0, [0x4d, 0x4d, 0, 0x2a])) &&
      b.at(8) !== 0x43 &&
      b.at(9) !== 0x52,
  ],
  ["image/bmp", is(1, 0, "BM")],
  ["image/vnd.ms-photo", is(2, 0, [0x49, 0x49, 0xbc])],
  ["image/vnd.adobe.photoshop", is(3, 0, "8BPS")],
  ["image/vnd.microsoft.icon", is(3, 0, [0, 0, 1, 0])],
  [
    "image/heif",
    (b) => {
      const ftyp = ftypBrands(b);
      if (!ftyp) return false;
      if (ftyp.major === "heic" || ftyp.major === "heix") return true;
      return (
        (ftyp.major === "mif1" || ftyp.major === "msf1") &&
        ftyp.brands.includes("heic")
      );
    },
  ],
  [
    "image/avif",
    (b) => {
      const ftyp = ftypBrands(b);
      if (!ftyp) return false;
      return (
        ["avif", "avis"].includes(ftyp.major) ||
        ftyp.brands.some((brand) => brand === "avif" || brand === "avis")
      );
    },
  ],
  [
    "image/jxl",
    (b) =>
      (b.length > 2 && eq(b, 0, [0xff, 0x0a])) ||
      (b.length > 12 &&
        eq(
          b,
          0,
          [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a],
        )),
  ],
  [
    "image/openraster",
    (b) =>
      b.length > 57 && eq(b, 0, ZIP) && eq(b, 30, "mimetypeimage/openraster"),
  ],
  [
    "image/vnd.djvu",
    (b) => b.length > 14 && eq(b, 0, "AT&TFORM") && eq(b, 12, "DJV"),
  ],
  [
    "video/mp4",
    (b) =>
      b.length > 11 &&
      eq(b, 4, "ftyp") &&
      MP4_FTYP.some((brand) => eq(b, 8, brand)),
  ],
  ["video/x-m4v", is(10, 4, "ftypM4V")],
  [
    "video/x-matroska",
    (b) =>
      (b.length > 15 &&
        eq(b, 0, [
          0x1a,
          0x45,
          0xdf,
          0xa3,
          0x93,
          0x42,
          0x82,
          0x88,
          ...[..."matroska"].map((c) => c.charCodeAt(0)),
        ])) ||
      (b.length > 38 && eq(b, 31, "matroska")),
  ],
  ["video/webm", is(3, 0, [0x1a, 0x45, 0xdf, 0xa3])],
  [
    "video/quicktime",
    (b) =>
      b.length > 15 &&
      ((eq(b, 4, "ftyp") && eq(b, 8, "qt  ")) ||
        eq(b, 4, "moov") ||
        eq(b, 4, "mdat") ||
        eq(b, 12, "mdat")),
  ],
  [
    "video/x-msvideo",
    (b) => b.length > 10 && eq(b, 0, "RIFF") && eq(b, 8, "AVI"),
  ],
  [
    "video/x-ms-wmv",
    is(9, 0, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9]),
  ],
  [
    "video/mpeg",
    (b) =>
      b.length > 3 && eq(b, 0, [0, 0, 1]) && b.at(3) >= 0xb0 && b.at(3) <= 0xbf,
  ],
  ["video/x-flv", is(3, 0, [0x46, 0x4c, 0x56, 0x01])],
  ["audio/midi", is(3, 0, "MThd")],
  [
    "audio/mpeg",
    (b) => b.length > 2 && (eq(b, 0, "ID3") || eq(b, 0, [0xff, 0xfb])),
  ],
  [
    "audio/m4a",
    (b) => b.length > 10 && (eq(b, 4, "ftypM4A") || eq(b, 0, "M4A ")),
  ],
  [
    "audio/opus",
    (b) =>
      b.length > 3 &&
      eq(b, 0, "OggS") &&
      b.length > 35 &&
      eq(b, 28, "OpusHead"),
  ],
  ["audio/ogg", is(3, 0, "OggS")],
  ["audio/x-flac", is(3, 0, "fLaC")],
  ["audio/x-wav", (b) => b.length > 11 && eq(b, 0, "RIFF") && eq(b, 8, "WAVE")],
  ["audio/amr", is(11, 0, "#!AMR\n")],
  [
    "audio/aac",
    (b) =>
      b.length > 1 &&
      b.at(0) === 0xff &&
      (b.at(1) === 0xf1 || b.at(1) === 0xf9),
  ],
  [
    "audio/x-aiff",
    (b) => b.length > 11 && eq(b, 0, "FORM") && eq(b, 8, "AIFF"),
  ],
  ["audio/x-dsf", is(4, 0, "DSD ")],
  ["audio/x-ape", is(4, 0, "MAC ")],
  ["application/font-woff", is(7, 0, [0x77, 0x4f, 0x46, 0x46, 0, 1, 0, 0])],
  ["application/font-woff", is(7, 0, [0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0])],
  ["application/font-sfnt", is(4, 0, [0, 1, 0, 0, 0])],
  ["application/font-sfnt", is(4, 0, [0x4f, 0x54, 0x54, 0x4f, 0])],
  ["application/msword", (b) => ole2(b) === "doc"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    (b) => msooxml(b) === "docx",
  ],
  ["application/vnd.ms-excel", (b) => ole2(b) === "xls"],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    (b) => msooxml(b) === "xlsx",
  ],
  ["application/vnd.ms-powerpoint", (b) => ole2(b) === "ppt"],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    (b) => msooxml(b) === "pptx",
  ],
  [
    "application/vnd.oasis.opendocument.text",
    (b) =>
      eq(b, 0, ZIP) &&
      eq(b, 0x1e, "mimetype") &&
      eq(b, 0x32, "vnd.oasis.opendocument.text"),
  ],
  [
    "application/vnd.oasis.opendocument.spreadsheet",
    (b) =>
      eq(b, 0, ZIP) &&
      eq(b, 0x1e, "mimetype") &&
      !eq(b, 0x32, "vnd.oasis.opendocument.text") &&
      eq(b, 0x32, "vnd.oasis.opendocument.spreadsheet"),
  ],
  [
    "application/vnd.oasis.opendocument.presentation",
    (b) =>
      eq(b, 0, ZIP) &&
      eq(b, 0x1e, "mimetype") &&
      !eq(b, 0x32, "vnd.oasis.opendocument.text") &&
      !eq(b, 0x32, "vnd.oasis.opendocument.spreadsheet") &&
      eq(b, 0x32, "vnd.oasis.opendocument.presentation"),
  ],
  [
    "application/epub+zip",
    (b) =>
      b.length > 57 &&
      eq(b, 0, ZIP) &&
      eq(b, 30, "mimetypeapplication/epub+zip"),
  ],
  [
    "application/zip",
    (b) =>
      b.length > 3 &&
      b.at(0) === 0x50 &&
      b.at(1) === 0x4b &&
      ((b.at(2) === 3 && b.at(3) === 4) ||
        (b.at(2) === 5 && b.at(3) === 6) ||
        (b.at(2) === 7 && b.at(3) === 8) ||
        (b.length > 7 && eq(b, 2, [0x30, 0x30, 0x50, 0x4b, 3, 4]))),
  ],
  ["application/x-tar", (b) => b.length > 261 && eq(b, 257, "ustar")],
  ["application/x-par2", is(8, 0, "PAR2\0PKT")],
  [
    "application/vnd.rar",
    (b) =>
      b.length > 6 &&
      eq(b, 0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) &&
      (b.at(6) === 0 || b.at(6) === 1),
  ],
  ["application/gzip", is(2, 0, [0x1f, 0x8b, 0x08])],
  ["application/x-bzip2", is(2, 0, "BZh")],
  ["application/vnd.bzip3", is(4, 0, "BZ3v1")],
  [
    "application/x-7z-compressed",
    is(5, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  ],
  ["application/x-xz", is(5, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0])],
  ["application/pdf", is(3, 0, "%PDF")],
  [
    "application/x-shockwave-flash",
    (b) =>
      b.length > 2 && (b.at(0) === 0x43 || b.at(0) === 0x46) && eq(b, 1, "WS"),
  ],
  ["application/rtf", is(4, 0, "{\\rtf")],
  [
    "application/octet-stream",
    (b) =>
      b.length > 35 &&
      eq(b, 34, "LP") &&
      (eq(b, 8, [2, 0, 1]) || eq(b, 8, [1, 0, 0]) || eq(b, 8, [2, 0, 2])),
  ],
  ["application/postscript", is(1, 0, "%!")],
  ["application/vnd.sqlite3", is(3, 0, "SQLi")],
  ["application/x-nintendo-nes-rom", is(3, 0, [0x4e, 0x45, 0x53, 0x1a])],
  ["application/x-google-chrome-extension", is(3, 0, "Cr24")],
  [
    "application/vnd.ms-cab-compressed",
    (b) => b.length > 3 && (eq(b, 0, "MSCF") || eq(b, 0, "ISc(")),
  ],
  [
    "application/vnd.debian.binary-package",
    is(20, 0, "!<arch>\ndebian-binary"),
  ],
  ["application/x-unix-archive", is(6, 0, "!<arch>")],
  [
    "application/x-compress",
    (b) =>
      b.length > 1 &&
      b.at(0) === 0x1f &&
      (b.at(1) === 0xa0 || b.at(1) === 0x9d),
  ],
  ["application/x-lzip", is(3, 0, "LZIP")],
  ["application/x-rpm", is(96, 0, [0xed, 0xab, 0xee, 0xdb])],
  ["application/dicom", is(131, 128, "DICM")],
  [
    "application/zstd",
    (b) =>
      skippableFrames(
        b,
        (f) => f.length > 3 && eq(f, 0, [0x28, 0xb5, 0x2f, 0xfd]),
      ),
  ],
  [
    "application/x-lz4",
    (b) =>
      skippableFrames(
        b,
        (f) => f.length > 3 && eq(f, 0, [0x04, 0x22, 0x4d, 0x18]),
      ),
  ],
  ["application/x-ole-storage", is(7, 0, OLE)],
  [
    "application/x-cpio",
    (b) =>
      (b.length > 1 &&
        ((b.at(0) === 0xc7 && b.at(1) === 0x71) ||
          (b.at(0) === 0x71 && b.at(1) === 0xc7))) ||
      (b.length > 6 && eq(b, 0, "070701")),
  ],
  [
    "text/html",
    (b) => {
      const rest = trimmed(b);
      return HTML.some(
        (tag) =>
          startsWithIgnoreCase(rest, tag) &&
          rest.length > tag.length &&
          [0x20, 0x3e].includes(rest.at(tag.length)),
      );
    },
  ],
  [
    "text/xml",
    (b) => {
      let rest = trimmed(b);
      for (;;) {
        if (rest.length < 3) break;
        if (eq(rest, 0, [0xef, 0xbb, 0xbf])) rest = slice(rest, 3);
        else if (eq(rest, 0, [0xfe, 0xff]) || eq(rest, 0, [0xff, 0xfe]))
          rest = slice(rest, 2);
        else break;
      }
      return startsWithIgnoreCase(rest, "<?xml");
    },
  ],
  ["text/x-shellscript", (b) => b.length > 2 && eq(b, 0, "#!")],
];

function infer(buf: Bytes) {
  for (const [mime, matches] of MATCHERS) if (matches(buf)) return mime;
  return undefined;
}

const BLOCKED = new Set([
  "application/xhtml+xml",
  "image/svg+xml",
  "application/javascript",
  "text/javascript",
  "application/x-msdownload",
  "application/x-executable",
  "application/vnd.microsoft.portable-executable",
  "application/x-mach-binary",
  "application/x-sharedlib",
  "application/x-elf",
  "application/x-msi",
  "application/vnd.android.package-archive",
  "application/x-apple-diskimage",
]);

function decide(head: Uint8Array, size: number) {
  const sniff = bytes(head, head.length);
  if (infer(sniff) === "video/mp4" || isoBmffPayload(sniff))
    return looksLikeMp4(sniff) ? "video/mp4" : undefined;
  const whole = bytes(head, size);
  const mime = infer(whole);
  if (mime && IMAGE_PATH.has(mime)) return mime;
  if (isoBmffPayload(whole)) return undefined;
  if (!mime) return "application/octet-stream";
  if (/^(image|video|audio)\//.test(mime) || BLOCKED.has(mime)) return;
  return mime in MEDIA_EXTENSIONS ? mime : undefined;
}

/** `head` is the file's first `SNIFF_BYTES` bytes, or the whole file when
 * shorter. Throws `UNSUPPORTED_FILE` for a type the relay refuses or stores
 * under an extension outside `MEDIA_EXTENSIONS`. */
export function relayMediaType(head: Uint8Array, size: number) {
  if (!(head instanceof Uint8Array))
    throw new Error("The file head must be the file's first bytes.");
  if (!Number.isSafeInteger(size) || size < 1)
    throw new Error("The file size must be a positive whole number of bytes.");
  if (head.length !== Math.min(size, SNIFF_BYTES))
    throw new Error(
      `The file head must be the first ${SNIFF_BYTES} bytes, or the whole file when shorter.`,
    );
  let mime: string | undefined;
  try {
    mime = decide(head, size);
  } catch (error) {
    if (error !== UNKNOWN) throw error;
    mime = undefined;
  }
  if (!mime) throw new Error(UNSUPPORTED_FILE);
  return {
    mime,
    ext: MEDIA_EXTENSIONS[mime] ?? "bin",
  } as const;
}
