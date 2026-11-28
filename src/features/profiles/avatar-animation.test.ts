import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { avatarAnimationBlob, loadAvatarAnimation } from "./avatar-animation";
import { pngChunks, webpChunks } from "../messages/image-metadata";

const fixture = (extension: string) =>
  new Uint8Array(
    readFileSync(
      new URL(
        `../../../tests/fixtures/attachment-media/animated.${extension}`,
        import.meta.url,
      ),
    ),
  );
const join = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
};
const view = (b: Uint8Array) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength);
afterEach(() => vi.unstubAllGlobals());

it.each(["gif", "webp", "png"])(
  "accepts the existing real %s animation bytes",
  async (ext) => {
    const bytes = fixture(ext);
    const blob = avatarAnimationBlob(bytes);
    expect(blob.type).toBe(`image/${ext}`);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  },
);

it.each(["gif", "webp", "png"])(
  "rejects %s canvas dimensions before decoding",
  (ext) => {
    const bytes = fixture(ext);
    if (ext === "gif") view(bytes).setUint16(6, 513, true);
    else if (ext === "png") view(bytes).setUint32(16, 513);
    else {
      const header = webpChunks(bytes)[0]?.payload;
      if (!header) throw new Error("Missing fixture header");
      header.set([0, 2, 0], 4); // width is stored minus one.
    }
    expect(() => avatarAnimationBlob(bytes)).toThrow();
  },
);

function riff(kind: string, payload: Uint8Array) {
  const result = new Uint8Array(8 + payload.length + (payload.length & 1));
  result.set(new TextEncoder().encode(kind));
  view(result).setUint32(4, payload.length, true);
  result.set(payload, 8);
  return result;
}
function webpFrames(
  count: number,
  edge = 32,
  codec = "VP8L",
  encodedEdge = edge,
) {
  const head = new Uint8Array(10);
  head[0] = 2;
  for (const at of [4, 7]) head.set([(edge - 1) & 255, (edge - 1) >> 8, 0], at);
  const frame = new Uint8Array(16);
  for (const at of [6, 9])
    frame.set([(edge - 1) & 255, (edge - 1) >> 8, 0], at);
  const image = new Uint8Array(codec === "VP8L" ? 5 : 10);
  if (codec === "VP8L") {
    image[0] = 0x2f;
    view(image).setUint32(
      1,
      (encodedEdge - 1) | ((encodedEdge - 1) << 14),
      true,
    );
  } else {
    image.set([0x9d, 1, 0x2a], 3);
    view(image).setUint16(6, encodedEdge, true);
    view(image).setUint16(8, encodedEdge, true);
  }
  const output = join(
    new TextEncoder().encode("RIFF0000WEBP"),
    riff("VP8X", head),
    riff("ANIM", new Uint8Array(6)),
    ...Array.from({ length: count }, () =>
      riff("ANMF", join(frame, riff(codec, image))),
    ),
  );
  view(output).setUint32(4, output.length - 8, true);
  return output;
}

it.each(["VP8L", "VP8 "])(
  "rejects oversized encoded %s frames behind a small rectangle",
  (codec) => {
    expect(() => avatarAnimationBlob(webpFrames(2, 32, codec))).not.toThrow();
    expect(() => avatarAnimationBlob(webpFrames(2, 32, codec, 513))).toThrow();
  },
);

it("bounds actual WebP frame count and combined canvas storage", () => {
  expect(() => avatarAnimationBlob(webpFrames(128))).not.toThrow();
  expect(() => avatarAnimationBlob(webpFrames(129))).toThrow();
  expect(() => avatarAnimationBlob(webpFrames(96, 400))).not.toThrow();
  expect(() => avatarAnimationBlob(webpFrames(64, 512))).not.toThrow();
  expect(() => avatarAnimationBlob(webpFrames(65, 512))).toThrow();
});

it("cross-checks APNG's declared frames and rejects out-of-canvas frames", () => {
  const bytes = fixture("png");
  const chunks = pngChunks(bytes);
  const control = chunks.find((c) => c.kind === "acTL")?.payload;
  if (!control) throw new Error("Missing fixture animation control");
  view(control).setUint32(0, 1);
  expect(() => avatarAnimationBlob(bytes)).toThrow();
  view(control).setUint32(0, chunks.filter((c) => c.kind === "fcTL").length);
  const frame = chunks.find((c) => c.kind === "fcTL")?.payload;
  if (!frame) throw new Error("Missing fixture frame control");
  view(frame).setUint32(12, 512);
  expect(() => avatarAnimationBlob(bytes)).toThrow();
});

it("counts GIF image descriptors and rejects truncated sub-blocks", () => {
  const head = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0]);
  const frame = new Uint8Array([44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0]);
  expect(() =>
    avatarAnimationBlob(
      join(
        head,
        ...Array.from({ length: 128 }, () => frame),
        new Uint8Array([59]),
      ),
    ),
  ).not.toThrow();
  expect(() =>
    avatarAnimationBlob(
      join(
        head,
        ...Array.from({ length: 129 }, () => frame),
        new Uint8Array([59]),
      ),
    ),
  ).toThrow();
  expect(() => avatarAnimationBlob(join(head, frame.slice(0, -1)))).toThrow();
});

it("rejects unsupported bytes even with an image MIME header", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("<svg></svg>", {
        headers: { "content-type": "image/webp" },
      }),
    ),
  );
  await expect(
    loadAvatarAnimation("/protected", new AbortController().signal),
  ).rejects.toThrow();
});

it("rejects oversized declared bodies without reading them", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream({ cancel });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(stream, {
        headers: { "content-length": String(16 * 1024 * 1024 + 1) },
      }),
    ),
  );
  await expect(
    loadAvatarAnimation("/protected", new AbortController().signal),
  ).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
});

it("cancels at the byte cap when content-length is absent or misleading", async () => {
  for (const headers of [{}, { "content-length": "1" }]) {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(16 * 1024 * 1024));
        c.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const fetch = vi.fn().mockResolvedValue(new Response(stream, { headers }));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await expect(loadAvatarAnimation("/protected", signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledWith("/protected", { signal });
    expect(cancel).toHaveBeenCalledOnce();
  }
});

it("does not admit data returned after cancellation", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cancel = vi.fn();
  const stream = new ReadableStream({
    async pull(c) {
      started();
      await gate;
      c.enqueue(fixture("gif"));
    },
    cancel,
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
  const controller = new AbortController();
  const load = loadAvatarAnimation("/protected", controller.signal);
  const rejected = expect(load).rejects.toThrow();
  await reading;
  controller.abort();
  release();
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
});
