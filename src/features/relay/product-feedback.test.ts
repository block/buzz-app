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
