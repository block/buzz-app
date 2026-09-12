import { describe, expect, it } from "vitest";
import { createPulsePositions, validPulseRoute } from "./navigation";

describe("Pulse routes", () => {
  it("accepts bounded exact views and nested threads", () => {
    expect(
      validPulseRoute({
        view: "search",
        search: "query",
        channelId: "alpha",
        thread: "a".repeat(64),
      }),
    ).toBe(true);
    expect(validPulseRoute({ view: "for-you", search: "" })).toBe(true);
  });
  it("rejects malformed/unbounded params and threads without a channel", () => {
    for (const value of [
      null,
      { view: ["all"], search: "" },
      [],
      { view: "unknown", search: "" },
      { view: "all", search: "x".repeat(1025) },
      { view: "all", search: "", extra: 1 },
      { view: "all", search: "", channelId: "../secret" },
      { view: "all", search: "", thread: "a".repeat(64) },
    ])
      expect(validPulseRoute(value)).toBe(false);
  });
  it("bounds visit geometry and refreshes its recency", () => {
    const positions = createPulsePositions();
    for (let i = 0; i < 100; i++) positions.set(String(i), { top: i });
    positions.set("0", { top: 500, focus: "alpha:open" });
    positions.set("100", { top: 100 });
    expect(positions.get("1")).toBeUndefined();
    expect(positions.get("0")).toEqual({ top: 500, focus: "alpha:open" });
  });
});
