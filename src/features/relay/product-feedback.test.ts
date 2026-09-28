// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { validProductFeedback } from "../../../dev/relay-broker.mjs";
import { createOutbox } from "./outbox";
import { byteSize, OUTBOX_INPUT_MAX_BYTES } from "./budget";
import { keypair, signed } from "./testing";
import { feedbackEvent, PRODUCT_FEEDBACK_KIND } from "./product-feedback";

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
