// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pngChunks, snapshotChunk } from "../messages/image-metadata";
import {
  type AttachmentUpload,
  UploadError,
  type UploadedAttachment,
} from "../relay/attachments";
import {
  avatarCropBox,
  avatarPictureError,
  avatarPreview,
  profilePictureError,
  uploadAnimatedAvatar,
  uploadAvatar,
} from "./avatar-upload";

const uploaded = (type: string, url: string): UploadedAttachment => ({
  name: "avatar",
  type,
  url,
  size: 1,
  sha256: "0".repeat(64),
});
const uploadAttachment = vi.fn<AttachmentUpload>(async (file) =>
  uploaded(file.type, "https://relay.example.test/media/avatar.png"),
);
vi.mock("../communities/connection", () => ({
  connectCommunityTransport: async () => ({ uploadAttachment }),
}));

it("strips private snapshot metadata at the avatar upload boundary", async () => {
  const bytes = snapshotPng("INERT_PRIVATE_MEMORY");
  const file = new File([bytes], "snapshot.agent.png", { type: "image/png" });
  const signal = new AbortController().signal;
  expect(snapshotChunk(pngChunks(bytes))).toBeDefined();
  await uploadAvatar(file, "https://relay.example.test", signal);
  const outgoing = uploadAttachment.mock.calls[0]?.[0];
  expect(outgoing).toBeDefined();
  if (!outgoing) throw new Error("Avatar upload was not attempted");
  const avatarBytes = new Uint8Array(await outgoing.arrayBuffer());
  expect(snapshotChunk(pngChunks(avatarBytes))).toBeUndefined();
  expect(
    pngChunks(avatarBytes).find((chunk) => chunk.kind === "IDAT")?.raw,
  ).toEqual(pngChunks(bytes).find((chunk) => chunk.kind === "IDAT")?.raw);
});

it.each(["iCCP", "eXIf"])(
  "redraws a still PNG with %s before uploading and excludes private metadata",
  async (kind) => {
    uploadAttachment.mockClear();
    const source = snapshotPng("Inert");
    const exif = new Uint8Array(28);
    exif.set(new TextEncoder().encode("Exif\0\0II"));
    const tiff = new DataView(exif.buffer, 6);
    tiff.setUint16(2, 42, true);
    tiff.setUint32(4, 8, true);
    tiff.setUint16(8, 1, true);
    tiff.setUint16(10, 0x112, true);
    tiff.setUint16(12, 3, true);
    tiff.setUint32(14, 1, true);
    tiff.setUint16(18, 6, true);
    const header = pngChunks(source)[0]?.raw;
    if (!header) throw new Error("Missing PNG header");
    const bytes = new Uint8Array([
      ...source.subarray(0, 8),
      ...header,
      ...pngChunk(kind, kind === "iCCP" ? new Uint8Array([1]) : exif),
      ...source.subarray(8 + header.length),
    ]);
    const redraw = snapshotPng("Inert");
    const bitmap = { width: 1, height: 1, close: vi.fn() };
    const originalBitmap = globalThis.createImageBitmap;
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: vi.fn(async () => bitmap),
    });
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage: vi.fn() } as never);
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation((callback) => {
        callback(new Blob([redraw], { type: "image/png" }));
      });
    try {
      await uploadAvatar(
        new File([bytes], "avatar.png", { type: "image/png" }),
        "https://relay.example.test",
        new AbortController().signal,
      );
      expect(createImageBitmap).toHaveBeenCalledOnce();
      expect(bitmap.close).toHaveBeenCalledOnce();
      expect(getContext.mock.results.length).toBeGreaterThan(0);
      expect(toBlob).toHaveBeenCalledOnce();
      const sent = uploadAttachment.mock.calls[0]?.[0];
      if (!sent) throw new Error("Avatar was not uploaded");
      expect(
        snapshotChunk(pngChunks(new Uint8Array(await sent.arrayBuffer()))),
      ).toBeUndefined();
    } finally {
      getContext.mockRestore();
      toBlob.mockRestore();
      Object.defineProperty(globalThis, "createImageBitmap", {
        configurable: true,
        value: originalBitmap,
      });
    }
  },
);

describe("an animated avatar", () => {
  const relay = "https://relay.example.test";
  const poster = `${relay}/media/${"a".repeat(64)}.png`;
  const animation = `${relay}/media/${"b".repeat(64)}.png`;
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
  const parts = () => ({
    poster: new File([snapshotPng("Inert")], "avatar.png", {
      type: "image/png",
    }),
    animation: new File([webm], "avatar.webm", { type: "video/webm" }),
  });
  beforeEach(() => {
    uploadAttachment.mockClear();
  });

  it("converts the WebM first, then uploads the stripped poster, and saves both as one descriptor", async () => {
    uploadAttachment
      .mockResolvedValueOnce(uploaded("image/png", animation))
      .mockResolvedValueOnce(uploaded("image/png", poster));
    const picture = await uploadAnimatedAvatar(
      parts(),
      relay,
      new AbortController().signal,
    );
    expect(picture).toBe(
      `${poster}#buzz-anim=${encodeURIComponent(animation)}`,
    );
    const [moving, still] = uploadAttachment.mock.calls;
    if (!moving || !still) throw new Error("Both parts were not uploaded");
    expect(moving[3]).toBe("animation");
    expect(new Uint8Array(await moving[0].arrayBuffer())).toEqual(webm);
    expect(still[3]).toBeUndefined();
    expect(
      snapshotChunk(pngChunks(new Uint8Array(await still[0].arrayBuffer()))),
    ).toBeUndefined();
  });

  it("keeps progress moving forward when the converted animation outgrows the WebM", async () => {
    uploadAttachment
      .mockImplementationOnce(async (_file, _signal, progress) => {
        // Lossless APNG is usually several times the VP9 WebM.
        progress?.(1_000_000, 2_000_000);
        progress?.(2_000_000, 2_000_000);
        return uploaded("image/png", animation);
      })
      .mockImplementationOnce(async (file, _signal, progress) => {
        progress?.(file.size / 2, file.size);
        progress?.(file.size, file.size);
        return uploaded("image/png", poster);
      });
    const seen: number[] = [];
    await uploadAnimatedAvatar(
      parts(),
      relay,
      new AbortController().signal,
      (sent, total) => seen.push(sent / total),
    );
    expect(seen.length).toBe(4);
    expect(seen.at(-1)).toBeCloseTo(1);
    for (const [i, value] of seen.entries()) {
      expect(value).toBeLessThanOrEqual(1);
      expect(value).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
    }
  });

  it("stores nothing when the animation can't be converted", async () => {
    uploadAttachment.mockRejectedValueOnce(new UploadError("video"));
    await expect(
      uploadAnimatedAvatar(parts(), relay, new AbortController().signal),
    ).rejects.toThrow("Couldn't convert this Gloopie's animation.");
    expect(uploadAttachment).toHaveBeenCalledOnce();
  });
});

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4, -4)) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  view.setUint32(8 + payload.length, (crc ^ 0xffffffff) >>> 0);
  return out;
}

/** A 1x1 transparent PNG carrying an agent-snapshot text chunk, as old Buzz
 * shares wrote them. */
function snapshotPng(manifest: string): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, 1);
  new DataView(header.buffer).setUint32(4, 1);
  header.set([8, 6], 8);
  return new Uint8Array([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...pngChunk("IHDR", header),
    ...pngChunk(
      "tEXt",
      new TextEncoder().encode(`buzz_agent_snapshot\0${btoa(manifest)}`),
    ),
    // Zlib stored block holding filter 0 and one transparent RGBA pixel.
    ...pngChunk(
      "IDAT",
      new Uint8Array([
        0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, 0, 0, 0, 0, 0, 0x00, 0x05,
        0x00, 0x01,
      ]),
    ),
    ...pngChunk("IEND", new Uint8Array()),
  ]);
}

it("forwards the requested size so previews share the message-row thumbnail URL", () => {
  const sha = "c".repeat(64);
  const community = "https://relay.example.test";
  const proxied = (target: string) =>
    `/api/relay/${encodeURIComponent(community)}/media?url=${encodeURIComponent(target)}`;
  const picture = `${community}/media/${sha}.png`;
  expect(avatarPreview(picture, community, "small")).toBe(
    proxied(`${community}/media/${sha}.thumb.webp`),
  );
  // The editor keeps the original for its large frame.
  expect(avatarPreview(picture, community)).toBe(proxied(picture));
});

it("keeps a panned and zoomed image covering the avatar frame", () => {
  // A 2:1 image covers the frame at zoom 1 and pans only sideways.
  expect(avatarCropBox(2, { zoom: 1, x: 0.8, y: 0.3 })).toEqual({
    crop: { zoom: 1, x: 0.5, y: 0 },
    width: 2,
    height: 1,
    left: 0,
    top: 0,
  });
  expect(avatarCropBox(1, { zoom: 2, x: -0.2, y: 0.9 })).toEqual({
    crop: { zoom: 2, x: -0.2, y: 0.5 },
    width: 2,
    height: 2,
    left: -0.7,
    top: 0,
  });
});

it("saves Buzz mobile's emoji avatar as-is in a personal profile only", () => {
  const emoji = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="256" fill="#FFB84D"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">🛹</text></svg>',
  )}`;
  for (const picture of [
    emoji,
    ` ${emoji}\n`,
    " https://images.example/a.png ",
  ])
    expect(profilePictureError(picture)).toBeUndefined();
  expect(profilePictureError("data:image/svg+xml,%3Csvg%3E")).toBeDefined();
  // Agents save HTTPS pictures only.
  expect(avatarPictureError(emoji)).toBeDefined();
  expect(avatarPictureError(" https://images.example/a.png ")).toBeUndefined();
});
