// @vitest-environment jsdom
import { expect, it } from "vitest";
import { feedbackImage, feedbackDiagnostics } from "./prepare-feedback";

it("prepares metadata-bearing feedback PNG without forwarding private text chunks", async () => {
  const enc = new TextEncoder();
  const chunk = (name: string, payload: Uint8Array) => {
    const result = new Uint8Array(payload.length + 12);
    new DataView(result.buffer).setUint32(0, payload.length);
    result.set(enc.encode(name), 4);
    result.set(payload, 8);
    return result;
  };
  const input = new File(
    [
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", new Uint8Array(13)),
      chunk("tEXt", enc.encode("buzz_agent_snapshot\0PRIVATE")),
      chunk("IDAT", new Uint8Array([1])),
      chunk("IEND", new Uint8Array()),
    ],
    "screenshot.png",
    { type: "image/png" },
  );
  // The real pixel encoder is exercised by message attachment tests; this
  // fixture exercises feedback's additional removal of editor snapshot metadata.
  const oldBitmap = globalThis.createImageBitmap;
  const oldCanvas = document.createElement;
  const fake = { width: 1, height: 1, close() {} } as ImageBitmap;
  globalThis.createImageBitmap = async () => fake;
  document.createElement = ((name: string) =>
    name === "canvas"
      ? {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage() {} }),
          toBlob: (cb: (b: Blob) => void) => cb(input),
        }
      : oldCanvas.call(document, name)) as typeof document.createElement;
  try {
    const output = await feedbackImage(input, new AbortController().signal);
    expect(await output.text()).not.toContain("PRIVATE");
    expect(output.type).toBe("image/png");
  } finally {
    globalThis.createImageBitmap = oldBitmap;
    document.createElement = oldCanvas;
  }
});

it("diagnostics are bounded to disclosed environment metadata", async () => {
  const data = await feedbackDiagnostics(new Date("2026-01-01T00:00:00Z"));
  expect(data.type).toBe("text/plain");
  expect(await data.text()).toContain("captured: 2026-01-01T00:00:00.000Z");
  expect(await data.text()).not.toMatch(/logs|channel|token/i);
});
