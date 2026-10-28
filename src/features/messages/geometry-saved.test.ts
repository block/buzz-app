// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { savedGeometry } from "./geometry";

afterEach(() => localStorage.clear());

const key = (scope: string) =>
  `buzz-view.v1:${JSON.stringify([scope, "timeline-geometry"])}`;

it("restores geometry saved when the page hid for the same rows and layout", async () => {
  savedGeometry.set("persist", "closed", "rows", "layout", [[10, 20], 40]);
  const stop = savedGeometry.live(() =>
    savedGeometry.set("persist", "open", "rows", "layout", [[30, -1], 40]),
  );
  window.dispatchEvent(new Event("pagehide"));
  stop();
  expect(localStorage.getItem(key("persist"))).not.toBeNull();
  vi.resetModules();
  const next = await import("./geometry");
  expect(next.savedGeometry.get("persist", "closed", "rows", "layout")).toEqual(
    [[10, 20], 40],
  );
  expect(next.savedGeometry.get("persist", "open", "rows", "layout")).toEqual([
    [30, -1],
    40,
  ]);
  // Changed rows, another width, font or pixel ratio, or another scope restore nothing.
  expect(
    next.savedGeometry.get("persist", "open", "edited", "layout"),
  ).toBeUndefined();
  expect(
    next.savedGeometry.get("persist", "open", "rows", "other"),
  ).toBeUndefined();
  expect(
    next.savedGeometry.get("other", "open", "rows", "layout"),
  ).toBeUndefined();
});

it("forgets the oldest channels", () => {
  for (let index = 0; index <= 16; index++)
    savedGeometry.set("bound", `c${index}`, "rows", "layout", [[1], 40]);
  expect(savedGeometry.get("bound", "c0", "rows", "layout")).toBeUndefined();
  expect(savedGeometry.get("bound", "c1", "rows", "layout")).toEqual([[1], 40]);
});

it("ignores malformed saved geometry", async () => {
  savedGeometry.set("malformed", "room", "rows", "layout", [[1], 40]);
  window.dispatchEvent(new Event("pagehide"));
  const stored = JSON.parse(localStorage.getItem(key("malformed")) ?? "{}");
  for (const cache of [null, [["40"]], [[-2]], [[1], 0], [[1], "tall"]]) {
    localStorage.setItem(
      key("malformed"),
      JSON.stringify({ room: { ...stored.room, cache } }),
    );
    vi.resetModules();
    const next = await import("./geometry");
    expect(
      next.savedGeometry.get("malformed", "room", "rows", "layout"),
    ).toBeUndefined();
  }
});
