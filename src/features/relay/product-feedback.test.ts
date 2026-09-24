import { describe, expect, it } from "vitest";
import { validProductFeedback } from "../../../dev/relay-broker.mjs";
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
