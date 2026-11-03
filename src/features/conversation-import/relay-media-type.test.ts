import { expect, it } from "vitest";
import {
  relayMediaType,
  SNIFF_BYTES,
  UNSUPPORTED_FILE,
} from "./relay-media-type";

const text = (value: string) => new TextEncoder().encode(value);
const join = (...parts: (Uint8Array | number[] | string)[]) => {
  const chunks = parts.map((part) =>
    typeof part === "string" ? text(part) : Uint8Array.from(part),
  );
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};
const whole = (bytes: Uint8Array) => relayMediaType(bytes, bytes.length);

/** A ZIP local file header whose first entry is `name`. */
function zipEntry(name: string, body = "") {
  const header = new Uint8Array(30);
  header.set([0x50, 0x4b, 0x03, 0x04]);
  new DataView(header.buffer).setUint32(18, body.length, true);
  new DataView(header.buffer).setUint16(26, name.length, true);
  return join(header, name, body);
}

it("sniffs images, documents and archives as the relay does", () => {
  expect(whole(join([0xff, 0xd8, 0xff, 0xe0], "JFIF"))).toEqual({
    mime: "image/jpeg",
    ext: "jpg",
  });
  expect(whole(join("RIFF", [0, 0, 0, 0], "WEBPVP8 "))).toEqual({
    mime: "image/webp",
    ext: "webp",
  });
  expect(
    whole(join(zipEntry("word/document.xml"), new Uint8Array(64))),
  ).toEqual({
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: "docx",
  });
  expect(
    whole(
      join(
        zipEntry("mimetype", "application/vnd.oasis.opendocument.text"),
        new Uint8Array(16),
      ),
    ).ext,
  ).toBe("odt");
  expect(whole(join(zipEntry("readme.txt"), new Uint8Array(64))).ext).toBe(
    "zip",
  );
  expect(whole(join([0x1f, 0x8b, 0x08, 0]))).toEqual({
    mime: "application/gzip",
    ext: "gz",
  });
  expect(whole(text("<!DOCTYPE html>\n<html></html>")).ext).toBe("html");
  expect(whole(text("{\\rtf1 hello}")).ext).toBe("rtf");
});

it("stores unsniffable text as an opaque download", () => {
  for (const sample of ['{"a":1}', "a,b\n1,2\n", "plain words\n"])
    expect(whole(text(sample))).toEqual({
      mime: "application/octet-stream",
      ext: "bin",
    });
});

it("treats an ISO media file as video, and only MP4 brands as supported", () => {
  const box = (brand: string, compatible: string) =>
    join([0, 0, 0, 0x18], "ftyp", brand, [0, 0, 2, 0], compatible);
  expect(whole(box("isom", "isomiso2"))).toEqual({
    mime: "video/mp4",
    ext: "mp4",
  });
  expect(() => whole(box("heic", "mif1heic"))).toThrow(UNSUPPORTED_FILE);
  expect(() => whole(box("qt  ", "qt  qt  "))).toThrow(UNSUPPORTED_FILE);
});

it("refuses what the relay refuses or stores outside the table", () => {
  for (const sample of [
    join("fLaC", [0, 0, 0, 0]),
    join("OggS", [0, 2, 0, 0]),
    join("RIFF", [0, 0, 0, 0], "WAVEfmt "),
    join("BM", [0, 0, 0, 0]),
    join("MZ", [0x90, 0]),
    text("<?xml version='1.0'?><svg/>"),
    text("#!/bin/sh\necho hi\n"),
    // The relay's sniff reads a leading "BC" as LLVM bitcode.
    text("BC,123\n"),
  ])
    expect(() => whole(sample)).toThrow(UNSUPPORTED_FILE);
});

it("needs exactly the file's first bytes, and refuses a type that depends on later ones", () => {
  const png = join([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(() => relayMediaType(png, 100)).toThrow("first 4096 bytes");
  const big = new Uint8Array(SNIFF_BYTES);
  big.set(png);
  expect(relayMediaType(big, 10_000_000).ext).toBe("png");
  // An OOXML package whose folder entry lies past the sniffed prefix.
  const ooxml = new Uint8Array(SNIFF_BYTES);
  ooxml.set(zipEntry("[Content_Types].xml"));
  expect(() => relayMediaType(ooxml, 1_000_000)).toThrow(UNSUPPORTED_FILE);
});
