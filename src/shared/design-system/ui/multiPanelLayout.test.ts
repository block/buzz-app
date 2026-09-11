import { describe, expect, it } from "vitest";
import {
  initialLayout,
  splitPane,
  combineTab,
  measureLayout,
  fitsLayout,
  resizeSplit,
} from "./multiPanelLayout";

const bounds = { x: 0, y: 0, width: 900, height: 600 };
describe("nested panel layout", () => {
  it("removes source before fitting the destination and preserves all tabs", () => {
    const original = initialLayout(3);
    const result = splitPane(original, "Three", "Two", "bottom");
    if (!result) throw new Error("Missing split");
    expect(original.root).toEqual(initialLayout(3).root);
    expect(result.groups.flatMap((g) => g.tabs).sort()).toEqual([
      "One",
      "Three",
      "Two",
    ]);
    const boxes = measureLayout(result.root, bounds, 8).panes;
    expect(boxes.get("One")?.height).toBe(600);
    expect(boxes.get("Two")?.x).toBe(boxes.get("Three")?.x);
    expect(boxes.get("Three")?.y).toBeGreaterThan(0);
    expect(fitsLayout(result, bounds, 8)).toBe(true);
    expect(fitsLayout(result, { ...bounds, width: 100 }, 8)).toBe(false);
  });
  it("extracts a tab into a split without duplicating it or leaving an empty group", () => {
    const combined = combineTab(initialLayout(4), "Four", "Two", "Four");
    if (!combined) throw new Error("Missing combine");
    const result = splitPane(combined, "Two", "Two", "bottom", "Four");
    if (!result) throw new Error("Missing extraction");
    expect(result.groups).toHaveLength(4);
    expect(new Set(result.groups.flatMap((g) => g.tabs)).size).toBe(4);
    expect(result.groups.every((g) => g.tabs.includes(g.selected))).toBe(true);
  });
  it("nested resizing does not change the outside pane", () => {
    const result = splitPane(initialLayout(3), "Three", "Two", "bottom");
    if (!result) throw new Error("Missing split");
    const before = measureLayout(result.root, bounds, 8);
    const nested = before.splits.find((s) => s.axis === "vertical");
    if (!nested) throw new Error("Missing divider");
    const after = measureLayout(
      resizeSplit(result.root, nested.id, 0.65),
      bounds,
      8,
    );
    expect(after.panes.get("One")).toEqual(before.panes.get("One"));
    expect(after.panes.get("Two")?.height).toBeGreaterThan(
      before.panes.get("Two")?.height ?? 0,
    );
  });
});
