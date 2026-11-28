// @vitest-environment node
import { deflateRawSync } from "node:zlib";
import { expect, it } from "vitest";
import { readGloopieZip } from "./gloopie-zip";

const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);
const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 5, 6, 7, 8, 9]);
const mp4 = Uint8Array.from([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
const gloopie: [string, Uint8Array<ArrayBuffer>][] = [
  ["gloopie.webm", webm],
  ["gloopie.mp4", mp4],
  ["gloopie.png", png],
];

/** A minimal ZIP: local headers, central directory and end record, no CRC. */
function zip(
  entries: [string, Uint8Array<ArrayBuffer>][],
  options: { deflate?: boolean; flags?: number } = {},
) {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const path = new TextEncoder().encode(name);
    const body = options.deflate ? new Uint8Array(deflateRawSync(data)) : data;
    const header = (signature: number, size: number) => {
      const bytes = new Uint8Array(size + path.length);
      const view = new DataView(bytes.buffer);
      const shift = signature === 0x04034b50 ? 0 : 2;
      view.setUint32(0, signature, true);
      view.setUint16(6 + shift, options.flags ?? 0, true);
      view.setUint16(8 + shift, options.deflate ? 8 : 0, true);
      view.setUint32(18 + shift, body.length, true);
      view.setUint32(22 + shift, data.length, true);
      view.setUint16(26 + shift, path.length, true);
      if (shift) view.setUint32(42, offset, true);
      bytes.set(path, size);
      return bytes;
    };
    const local = header(0x04034b50, 30);
    parts.push(local, body);
    central.push(header(0x02014b50, 46));
    offset += local.length + body.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new File([...parts, ...central, end.buffer], "gloopie.zip");
}

const read = (file: File) => readGloopieZip(file, new AbortController().signal);
const bytes = async (file: File) => new Uint8Array(await file.arrayBuffer());

it("reads the poster and animation from a Gloopie ZIP", async () => {
  const parts = await read(zip(gloopie));
  expect(parts?.poster.type).toBe("image/png");
  expect(parts?.animation.type).toBe("video/webm");
  if (!parts) throw new Error("ZIP was not read");
  expect(await bytes(parts.poster)).toEqual(png);
  expect(await bytes(parts.animation)).toEqual(webm);
});

it("reads a re-zipped copy with deflate and macOS resource forks", async () => {
  const parts = await read(
    zip([...gloopie, ["__MACOSX/._gloopie.png", png]], { deflate: true }),
  );
  if (!parts) throw new Error("ZIP was not read");
  expect(await bytes(parts.poster)).toEqual(png);
  expect(await bytes(parts.animation)).toEqual(webm);
});

it("leaves other files to the image path", async () => {
  expect(await read(new File([png], "avatar.png"))).toBeUndefined();
});

it("explains ZIPs it can't use", async () => {
  await expect(read(zip(gloopie.slice(1)))).rejects.toThrow(
    "isn't an animated Gloopie",
  );
  await expect(read(zip(gloopie, { flags: 1 }))).rejects.toThrow("can't open");
});
