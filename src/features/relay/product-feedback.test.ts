// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { validProductFeedback } from "../../../dev/relay-broker.mjs";
import { createOutbox } from "./outbox";
import { byteSize, OUTBOX_INPUT_MAX_BYTES } from "./budget";
import { keypair, signed } from "./testing";
import {
  feedbackEvent,
  feedbackImage,
  feedbackDiagnostics,
  PRODUCT_FEEDBACK_KIND,
} from "./product-feedback";

const event = (overrides: Record<string, unknown> = {}) => ({
  ...feedbackEvent("Works", "bug"),
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ["category", "bug"],
    ["client-id", "fixture"],
  ],
  ...overrides,
});

describe("product feedback protocol", () => {
  it("sends a private kind with bounded required text and optional category", () => {
    expect(feedbackEvent("  Good!  ", null)).toEqual({
      kind: PRODUCT_FEEDBACK_KIND,
      content: "Good!",
      tags: [],
    });
    expect(validProductFeedback(event())).toBe(true);
    expect(
      validProductFeedback(event({ tags: [["client-id", "fixture"]] })),
    ).toBe(true);
    expect(() => feedbackEvent(" \n ", null)).toThrow();
    expect(() => feedbackEvent("é".repeat(16_385), "bug")).toThrow();
  });
  it("rejects channel tags, malformed tags, duplicate or unsupported categories and oversized bodies", () => {
    for (const overrides of [
      { tags: [["h", "channel"]] },
      { tags: [null] },
      {
        tags: [
          ["category", "bug"],
          ["category", "praise"],
        ],
      },
      { tags: [["category", "other"]] },
      { content: " ".repeat(10) },
      { content: "a".repeat(32 * 1024 + 1) },
    ])
      expect(validProductFeedback(event(overrides))).toBe(false);
  });
});

const origin = "https://relay.test";
const hash = "a".repeat(64);
const image = {
  name: "capture.png",
  url: `${origin}/media/${hash}.png`,
  type: "image/png",
  size: 64,
  sha256: hash,
};

it("bounds feedback attachments to local validated media metadata", () => {
  const submitted = feedbackEvent("Issue", "bug", [image], origin);
  expect(submitted.content).toContain(image.url);
  // JS broker inference omits optional mediaOrigin without a declaration.
  const validate = validProductFeedback as (
    event: unknown,
    origin?: string,
  ) => boolean;
  expect(validate(event({ ...submitted }), origin)).toBe(true);
  for (const mutated of [
    { ...image, url: `https://attacker.test/media/${hash}.png` },
    { ...image, size: 0 },
    { ...image, sha256: "b".repeat(64) },
  ])
    expect(() => feedbackEvent("Issue", null, [mutated], origin)).toThrow();
  const imeta = submitted.tags.at(-1);
  if (!imeta) throw new Error("Missing image metadata");
  expect(validate(event({ tags: [[...imeta, "dim 100x100"]] }), origin)).toBe(
    true,
  );
  for (const tag of [
    imeta.slice(0, -1),
    [...imeta, "m image/jpeg"],
    imeta.map((part) => (part.startsWith("size ") ? "size NaN" : part)),
    imeta.map((part) => (part.startsWith("size ") ? "size 1e3" : part)),
    imeta.map((part) =>
      part.startsWith("url ") ? `url ${origin}/media/${hash}.jpg` : part,
    ),
    imeta.map((part) =>
      part.startsWith("filename ") ? "filename ../secret" : part,
    ),
    imeta.map((part) =>
      part.startsWith("url ") ? "url https://attacker.test/media/evil" : part,
    ),
  ])
    expect(validate(event({ tags: [tag] }), origin)).toBe(false);
});

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

it("preflights the same serialized input the production outbox admits", async () => {
  const viewer = keypair();
  const owner = createOutbox(
    viewer.pubkey,
    {
      kinds: [PRODUCT_FEEDBACK_KIND],
      sign: async (template) => signed(viewer, template),
      publish: async () => {},
    },
    { load: () => [], save() {} },
  );
  try {
    await owner.ready;
    const outbox = owner.outbox;
    for (const [category, character] of [
      [null, "a"],
      ["bug", '"'],
      ["praise", "é"],
    ] as const) {
      let low = 1;
      let high = OUTBOX_INPUT_MAX_BYTES;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        try {
          feedbackEvent(character.repeat(middle), category);
          low = middle;
        } catch {
          high = middle - 1;
        }
      }
      const admitted = feedbackEvent(character.repeat(low), category);
      expect(byteSize(admitted)).toBeLessThanOrEqual(OUTBOX_INPUT_MAX_BYTES);
      expect(() => outbox.send(admitted)).not.toThrow();
      expect(() => feedbackEvent(character.repeat(low + 1), category)).toThrow(
        "Feedback must contain text and fit within relay limits.",
      );
    }
  } finally {
    owner.dispose();
  }
});
