import { describe, expect, it } from "vitest";
import { formatPublicKey, publicKeyLabels } from "./public-key";

const first = "a".repeat(64);
const second = "b".repeat(64);

describe("public-key display", () => {
  it("uses canonical npub endings, not hex endings, and normalizes case", () => {
    expect(formatPublicKey(first)).toBe("npub…caj");
    expect(formatPublicKey(first.toUpperCase())).toBe("npub…caj");
    expect(formatPublicKey(second, 4)).toBe("npub…04hu");
  });

  it.each([
    "",
    "not-a-key",
    "a".repeat(63),
    "g".repeat(64),
    "nsec1secret",
    "npub1broken",
  ])("does not echo invalid input: %s", (input) => {
    expect(formatPublicKey(input)).toBeUndefined();
    expect(publicKeyLabels([input]).size).toBe(0);
  });

  it("bounds requested lengths and never drops the public-key prefix", () => {
    for (const length of [-1, 0, 2, NaN, Infinity, 3.5])
      expect(formatPublicKey(first, length)).toBe("npub…caj");
    expect(formatPublicKey(first, 999)).toMatch(/^npub…[a-z0-9]{58}$/);
  });

  it("deduplicates exact identities and uses stable labels independent of order", () => {
    const labels = publicKeyLabels([first, second, first.toUpperCase()]);
    expect([...labels]).toEqual([
      [first, "npub…caj"],
      [second, "npub…4hu"],
    ]);
    expect(publicKeyLabels([second, first])).toEqual(labels);
  });

  it("extends all labels in a group when three ending characters collide", () => {
    // Fixed canonical npubs ending 7c8a32 and 8mga32.
    const a = "08c5".padStart(64, "0");
    const b = "4000".padStart(64, "0");
    expect(formatPublicKey(a)).toBe("npub…a32");
    expect(formatPublicKey(b)).toBe("npub…a32");
    expect([...publicKeyLabels([a, b, first]).values()]).toEqual([
      "npub…8a32",
      "npub…ga32",
      "npub…rcaj",
    ]);
    expect(publicKeyLabels([]).size).toBe(0);
  });
});
