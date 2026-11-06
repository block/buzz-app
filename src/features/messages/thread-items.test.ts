import { expect, it } from "vitest";
import { stageEdges } from "./thread-items";

const ids = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => String(from + i));

it("passes through a change at the end alone, without shift", () => {
  const next = [...ids(0, 5), "live"];
  expect(stageEdges(ids(0, 5), next)).toEqual({ ids: next, shift: false });
  expect(stageEdges(ids(0, 5), ids(0, 3))).toEqual({
    ids: ids(0, 3),
    shift: false,
  });
});

it("stages an older page that lands while the newest page is evicted", () => {
  // Strict: an older page lands at the start, a newer one leaves the end.
  const previous = ids(10, 20);
  const next = ids(5, 15);
  const first = stageEdges(previous, next);
  expect(first).toEqual({ ids: ids(5, 20), shift: true });
  // The second pass changes only the end.
  expect(stageEdges(first.ids, next)).toEqual({ ids: next, shift: false });
});

it("stages a newer page read back while the oldest page is evicted", () => {
  // Strict: the oldest page leaves the start, an evicted newer one returns.
  const previous = ids(5, 15);
  const next = ids(10, 20);
  const first = stageEdges(previous, next);
  expect(first).toEqual({ ids: ids(10, 15), shift: true });
  expect(stageEdges(first.ids, next)).toEqual({ ids: next, shift: false });
});

it("stages a mixed snapshot: an older page and a live reply together", () => {
  const first = stageEdges(ids(10, 20), [...ids(5, 20), "live"]);
  expect(first).toEqual({ ids: ids(5, 20), shift: true });
});

it("replaces a window that shares nothing, without shift", () => {
  expect(stageEdges(ids(0, 5), ids(50, 55))).toEqual({
    ids: ids(50, 55),
    shift: false,
  });
  expect(stageEdges([], ids(0, 3))).toEqual({ ids: ids(0, 3), shift: false });
});
