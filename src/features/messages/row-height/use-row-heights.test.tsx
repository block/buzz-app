// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import type { CacheSnapshot, VirtualizerHandle } from "virtua";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../../relay/contracts";
import type { Metrics } from "./model";
import type { Placement } from "./placement";

// jsdom has no canvas: the environment is replaced by a ready one whose
// model counts its work.
const model = vi.hoisted(() => ({
  estimate: (() => 20) as (...args: unknown[]) => number,
  predict: (() => 40) as (...args: unknown[]) => number | string,
}));
vi.mock("./environment", () => {
  const metrics = {
    epoch: 1,
    inset: 0,
    single: { timeline: 40, continuation: 20 },
  } as unknown as Metrics;
  const snapshot = { model, metrics, hover: true, fonts: 0 };
  return {
    capable: true,
    calibrate: () => {},
    environment: { subscribe: () => () => {}, snapshot: () => snapshot },
  };
});
const { useRowHeights } = await import("./use-row-heights");

afterEach(() => {
  vi.restoreAllMocks();
});

const rows = Array.from(
  { length: 30 },
  (_, index) => ({ id: `m${index}` }) as ChannelMessage,
);
const placed: Placement[] = rows.map(() => ({
  day: false,
  layout: "continuation",
}));
const snapshot = [rows.map(() => 30), 30] as unknown as CacheSnapshot;
function mount(scroller: HTMLElement | null = null) {
  const handle = { current: null as VirtualizerHandle | null };
  const props = {
    rows,
    placed,
    rowWidth: 600,
    viewport: 400,
    landing: () => rows.length - 1,
    handle,
    scroller: { current: scroller },
    resolveName: (_: string, fallback: string) => fallback,
    profiles: new Map(),
    extensions: undefined,
  };
  const hook = renderHook((next: typeof props) => useRowHeights(next), {
    initialProps: props,
  });
  return { hook, handle, props };
}

it("predicts a saved snapshot's rows only in the render that creates the Virtualizer", () => {
  const predict = vi.spyOn(model, "predict");
  const { hook, handle, props } = mount();
  const created = hook.result.current.props(snapshot);
  expect(created.cache?.[0]).toEqual(rows.map(() => 40));
  // Virtua reads `cache` only at creation: later renders pass the snapshot
  // through without asking the model about every row again.
  handle.current = {} as VirtualizerHandle;
  predict.mockClear();
  for (let render = 0; render < 3; render++) {
    hook.rerender({ ...props });
    expect(hook.result.current.props(snapshot).cache).toBe(snapshot);
  }
  expect(predict).not.toHaveBeenCalled();
});

it("sizes rows left unknown at the median rough estimate of every row, whatever it predicted", () => {
  const index = (row: unknown) => rows.indexOf(row as ChannelMessage);
  // Every third row is taller than the rest: rows 0, 3, …, 27 estimate 100,
  // 103, …, 127, the others 20 each.
  vi.spyOn(model, "estimate").mockImplementation((row) =>
    index(row) % 3 ? 20 : 100 + index(row),
  );
  const itemSize = () =>
    (mount().hook.result.current.props(undefined) as { itemSize?: number })
      .itemSize;
  // The tall rows left to measurement, every row, or none: the rows a render
  // has time to predict do not change it. Over the unknown rows alone it
  // would be 115.
  const predict = vi.spyOn(model, "predict");
  for (const outcome of [
    (row: unknown) => (index(row) % 3 ? 40 : "markdown"),
    () => "font",
    () => 33,
  ]) {
    predict.mockImplementation(outcome);
    expect(itemSize()).toBe(20);
  }
});

// Virtua's sizes (-1: unmeasured) with the viewport starting at `start`.
function virtualizer(sizes: number[], start: number) {
  return {
    get cache() {
      return [sizes.slice(), 30] as unknown as CacheSnapshot;
    },
    scrollOffset: 0,
    findItemIndex: () => start,
    resize: vi.fn((pairs: readonly (readonly [number, number])[]) => {
      for (const [index, size] of pairs) sizes[index] = size;
    }),
  };
}

it("sets the unmeasured rows that are not mounted in one write", () => {
  const index = (row: unknown) => rows.indexOf(row as ChannelMessage);
  vi.spyOn(model, "predict").mockImplementation((row) =>
    index(row) === 5 ? "markdown" : 40 + index(row),
  );
  // Rows 20-22 are mounted, 21 not measured yet; 10 is measured.
  const scroller = document.createElement("section");
  for (const id of ["m20", "m21", "m22"]) {
    const item = document.createElement("div");
    item.dataset.messageId = id;
    scroller.append(item);
  }
  const sizes = rows.map((_, index) =>
    index === 10 ? 55 : index === 20 || index === 22 ? 60 : -1,
  );
  const { hook, handle } = mount(scroller);
  const list = virtualizer(sizes, 20);
  handle.current = list as unknown as VirtualizerHandle;
  expect(hook.result.current.fill(false)).toBe(true);
  expect(list.resize).toHaveBeenCalledTimes(1);
  expect(list.resize.mock.calls[0]?.[0]).toEqual(
    rows.flatMap((_, at) =>
      [5, 10, 20, 21, 22].includes(at) ? [] : [[at, 40 + at]],
    ),
  );
  // Nothing is left: a later slice writes nothing.
  expect(hook.result.current.fill(true)).toBe(true);
  expect(list.resize).toHaveBeenCalledTimes(1);
});

it("predicts in slices of the budget outward from the viewport, each row once, writing when asked and at the end", () => {
  // Each prediction takes 3 ms; a row predicted once is a cache hit.
  const prepared = new Set<unknown>();
  const predict = vi
    .spyOn(model, "predict")
    .mockImplementation((row, _, __, compute) => {
      if (compute) prepared.add(row);
      return prepared.has(row) ? 40 : "budget";
    });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (now += 3));
  const sizes = rows.map(() => -1);
  const { hook, handle } = mount();
  const list = virtualizer(sizes, 29);
  handle.current = list as unknown as VirtualizerHandle;
  predict.mockClear();
  prepared.clear();
  // Asked to write: the rows the first slice predicted.
  expect(hook.result.current.fill(true)).toBe(false);
  expect(list.resize.mock.calls).toEqual([
    [
      [
        [27, 40],
        [28, 40],
        [29, 40],
      ],
    ],
  ]);
  let slices = 2;
  for (; !hook.result.current.fill(false); slices++) {
    expect(slices, "each slice makes progress").toBeLessThan(rows.length);
    expect(list.resize).toHaveBeenCalledTimes(1);
  }
  expect(slices).toBeGreaterThan(5);
  // The row at the viewport, then each row above it, once.
  expect(
    predict.mock.calls
      .filter(([, , , compute]) => compute)
      .map(([row]) => rows.indexOf(row as ChannelMessage)),
  ).toEqual(rows.map((_, at) => 29 - at));
  expect(list.resize).toHaveBeenCalledTimes(2);
  expect(list.resize.mock.calls[1]?.[0]).toEqual(
    rows.slice(0, 27).map((_, at) => [at, 40]),
  );
});

it("writes a row the fill tried at its index and placement when it writes", () => {
  vi.spyOn(model, "predict").mockImplementation((_, at) =>
    (at as Placement).day ? 70 : 40,
  );
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (now += 3));
  const { hook, handle, props } = mount();
  handle.current = virtualizer(
    rows.map(() => -1),
    29,
  ) as unknown as VirtualizerHandle;
  // The first slice tries rows 29, 28 and 27.
  expect(hook.result.current.fill(false)).toBe(false);
  // Then two older rows arrive, and row 29 starts a new day.
  const older = [{ id: "p0" }, { id: "p1" }] as ChannelMessage[];
  const next = {
    ...props,
    rows: [...older, ...rows],
    placed: [
      ...older.map(() => placed[0] as Placement),
      ...placed.slice(0, -1),
      { day: true, layout: "timeline" } as Placement,
    ],
  };
  hook.rerender(next);
  const list = virtualizer(
    next.rows.map(() => -1),
    31,
  );
  handle.current = list as unknown as VirtualizerHandle;
  for (let slice = 0; !hook.result.current.fill(false); slice++)
    expect(slice, "each slice makes progress").toBeLessThan(next.rows.length);
  expect(list.resize).toHaveBeenCalledTimes(1);
  const pairs = list.resize.mock.calls[0]?.[0] ?? [];
  expect(pairs).toHaveLength(32);
  expect(pairs.at(-1)).toEqual([31, 70]);
  expect(pairs.slice(0, -1).every(([, size]) => size === 40)).toBe(true);
});

it("tries every row again for a new Virtualizer", () => {
  // Predictions computed for one font epoch; a text-scale change starts
  // another, where earlier text is a miss until prepared again.
  let epoch = 0;
  const prepared = new Map<unknown, number>();
  vi.spyOn(model, "predict").mockImplementation((row, _, __, compute) => {
    if (compute) prepared.set(row, epoch);
    return prepared.get(row) === epoch ? 40 : "budget";
  });
  // Each prediction takes 3 ms: creation prepares only the rows around the
  // landing row, the fill the rest.
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (now += 3));
  const { hook, handle, props } = mount();
  const fill = (list: ReturnType<typeof virtualizer>) => {
    handle.current = list as unknown as VirtualizerHandle;
    for (let slice = 0; !hook.result.current.fill(false); slice++)
      expect(slice, "each slice makes progress").toBeLessThan(rows.length);
    return list.resize.mock.calls.flatMap(([pairs]) => pairs).length;
  };
  expect(
    fill(
      virtualizer(
        rows.map(() => -1),
        29,
      ),
    ),
  ).toBe(30);
  epoch++;
  handle.current = null;
  hook.rerender({ ...props });
  expect(
    fill(
      virtualizer(
        rows.map(() => -1),
        29,
      ),
    ),
  ).toBe(30);
});

it("leaves a Virtualizer created without predictions to Virtua's estimate", () => {
  const { hook, handle, props } = mount();
  hook.unmount();
  // Created before the list had a width; predictions are ready later.
  const late = renderHook((next: typeof props) => useRowHeights(next), {
    initialProps: { ...props, rowWidth: 0 },
  });
  const list = virtualizer(
    rows.map(() => -1),
    29,
  );
  handle.current = list as unknown as VirtualizerHandle;
  late.rerender({ ...props });
  expect(late.result.current.fill(true)).toBe(true);
  expect(list.resize).not.toHaveBeenCalled();
});
