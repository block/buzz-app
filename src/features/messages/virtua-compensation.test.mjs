import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Exercise the installed React ESM's actual store, observer and element driver.
// Names are deliberately version-coupled: review this extraction on upgrade.
const source = readFileSync(
  fileURLToPath(import.meta.resolve("virtua")),
  "utf8",
);
const start = source.indexOf("var {min:");
const end = source.indexOf("}, W = (e, t) => {");
if (start < 0 || end < 0)
  throw new Error("Review Virtua driver extraction after version change");
const helperStart = source.indexOf("const isMacWebKit =");
const helper = helperStart >= 0 ? source.slice(helperStart, start) : "";
const core = source.slice(start, end + 1);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup({
  platform = "MacIntel",
  vendor = "Apple Computer, Inc.",
  touch = 0,
  agent = "Macintosh",
  horizontal = false,
  direction = "ltr",
  offset = 1300,
  cache,
  estimate,
  itemSize = 100,
} = {}) {
  const {
    store: createStore,
    layout,
    driver: createDriver,
  } = new Function(
    "navigator",
    "getComputedStyle",
    `${helper}${core};return {store:y,layout:R,driver:E};`,
  )({ platform, vendor, maxTouchPoints: touch, userAgent: agent }, () => ({
    direction,
  }));
  const store = createStore(layout(20, itemSize, cache, estimate));
  const declarations = new Map();
  const style = {
    getPropertyValue: (name) => declarations.get(name)?.[0] ?? "",
    getPropertyPriority: (name) => declarations.get(name)?.[1] ?? "",
    setProperty: (name, value, priority = "") =>
      declarations.set(name, [value, priority]),
    removeProperty: (name) => declarations.delete(name),
  };
  const viewport = new EventTarget();
  const calls = [];
  const observed = [];
  const frames = [];
  let resize;
  const axis = horizontal ? "overflow-x" : "overflow-y";
  const key = horizontal ? "scrollLeft" : "scrollTop";
  const option = horizontal ? "left" : "top";
  Object.assign(viewport, {
    style,
    offsetParent: {},
    scrollTop: 0,
    scrollLeft: 0,
    ownerDocument: {
      defaultView: {
        ResizeObserver: class {
          constructor(callback) {
            resize = callback;
          }
          observe(target) {
            observed.push(["observe", target]);
          }
          unobserve(target) {
            observed.push(["unobserve", target]);
          }
          disconnect() {}
        },
        // Row measurements wait for the next frame; `frame()` runs it.
        requestAnimationFrame: (callback) => frames.push(callback),
        cancelAnimationFrame: (id) => {
          frames[id - 1] = () => {};
        },
      },
    },
  });
  viewport[key] = direction === "rtl" ? -offset : offset;
  // With a range set, act like a browser after a shrink: layout clamps the
  // current offset before a relative scroll reads it, and the result is an
  // integer inside the range, as WebKit reports it.
  const clamp = (value) =>
    viewport.max === undefined
      ? value
      : Math.trunc(Math.min(value, viewport.max));
  for (const method of ["scrollTo", "scrollBy"])
    viewport[method] = (options) => {
      calls.push({
        method,
        options,
        overflow: style.getPropertyValue(axis),
        priority: style.getPropertyPriority(axis),
      });
      viewport[key] = clamp(
        (method === "scrollBy" ? clamp(viewport[key]) : 0) + options[option],
      );
    };
  store.W(4, 500); // measured viewport
  store.W(1, offset); // observed native scrolling
  const driver = createDriver(store, horizontal);
  driver.D({}, viewport);
  return {
    store,
    driver,
    viewport,
    style,
    axis,
    calls,
    observed,
    resize: (entries) => resize(entries),
    frame() {
      for (const callback of frames.splice(0)) callback();
    },
    // Render computes the mounted range between the length change and the
    // layout effect that flushes the jump; ChannelTimeline's buffer is 1600.
    // The render's `estimateSize` travels with the length change.
    prepend(length = 40, buffer = 1600, estimate) {
      store.W(5, [length, true, estimate]);
      store.i(buffer);
      driver.J();
    },
  };
}

it("interrupts the actual correction before its relative DOM write, even after inferred idle", () => {
  const c = setup();
  c.store.W(2); // observer idle is NOT native momentum completion
  c.prepend();
  expect(c.calls).toEqual([
    {
      method: "scrollBy",
      options: { top: 2000, behavior: "instant" },
      overflow: "hidden",
      priority: "important",
    },
  ]);
  expect(c.viewport.scrollTop).toBe(3300);
  expect(c.store.t()).toBe(4000); // no deferred extent/store policy
  expect(c.store.u(39)).toBe(3900);
  c.driver.J();
  expect(c.calls).toHaveLength(1);
  vi.runAllTimers();
  expect(c.style.getPropertyValue(c.axis)).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});

it("does not defer while scrolling or interrupt without a correction", () => {
  const c = setup();
  c.driver.J();
  expect(c.calls).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
  c.prepend();
  expect(c.calls).toHaveLength(1);
  expect(c.store.t()).toBe(4000);
  expect(c.store.L()[0]).toBe(0);
});

it("buffers both sides while a shift freezes the scroll direction", () => {
  const c = setup({ offset: 500 }); // native downward scrolling
  c.prepend();
  c.store.W(1, 2500); // compensated offset
  c.store.W(1, 2400); // upward movement cannot update the frozen direction
  expect(c.store.i(200)).toEqual([22, 31]);
  c.store.W(2); // inferred idle restores native direction tracking
  c.store.W(1, 2300);
  expect(c.store.i(200)).toEqual([21, 28]);
});

it("buffers below a shift frozen upward without letting those rows move the reading position", () => {
  for (const [row, size, top] of [
    [32, 150, null], // wholly below the 2500–3000 viewport
    [32, 60, null],
    [23, 150, 50], // above it, as prepended rows are
    [29, 150, 50], // visible rows are still corrected
    [30, 150, null], // starts exactly at the viewport end
  ]) {
    const c = setup({ offset: 500 });
    c.store.W(1, 400); // native upward scrolling
    c.prepend();
    c.store.W(1, 2400); // compensated offset
    c.store.W(1, 2500); // downward movement cannot update the frozen direction
    expect(c.store.i(200)).toEqual([23, 32]);
    c.calls.length = 0;
    c.store.W(3, [[row, size]]);
    c.driver.J();
    expect(c.calls.map((call) => call.options.top ?? null)).toEqual(
      top === null ? [] : [top],
    );
    c.driver._();
  }
});

it("preserves absolute edge correction and RTL axis normalization", () => {
  for (const config of [
    { offset: 1500 },
    { horizontal: true, direction: "rtl", offset: 1500 },
  ]) {
    const c = setup(config);
    c.prepend();
    expect(c.calls).toEqual([
      {
        method: "scrollTo",
        options: {
          [config.horizontal ? "left" : "top"]: config.horizontal
            ? -3500
            : 3500,
          behavior: "instant",
        },
        overflow: "hidden",
        priority: "important",
      },
    ]);
    c.driver._();
  }
});

it.each(["MacIntel", "Linux x86_64"])(
  "rounds fractional end corrections outward on %s, including RTL",
  (platform) => {
    for (const horizontal of [false, true]) {
      const c = setup({
        platform,
        horizontal,
        direction: horizontal ? "rtl" : "ltr",
        offset: 1500,
      });
      c.store.W(3, [[0, 100.75]]);
      c.driver.J();
      expect(c.calls.at(-1)).toMatchObject({
        method: "scrollTo",
        options: {
          [horizontal ? "left" : "top"]: horizontal ? -1501 : 1501,
          behavior: "instant",
        },
      });
      c.driver._();
    }
  },
);

it("rounds imperative end targets without rounding interior reading positions", async () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  c.store.W(
    3,
    Array.from({ length: 20 }, (_, index) => [index, index ? 100 : 100.75]),
  );
  for (const [target, expected] of [
    [900.25, 900.25],
    [1500.75, 1501],
  ]) {
    await c.driver.V(() => target, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls.at(-1).options).toEqual({
      top: expected,
      behavior: "instant",
    });
  }
  c.driver._();
});

it("restores exact value and priority after overlapping corrections without touching the other axis", () => {
  const c = setup();
  c.style.setProperty("overflow-y", "scroll", "important");
  c.style.setProperty("overflow-x", "clip", "");
  c.prepend();
  c.prepend(60);
  expect(c.calls.map((call) => call.overflow)).toEqual(["hidden", "hidden"]);
  expect(vi.getTimerCount()).toBe(1);
  expect(c.style.getPropertyValue("overflow-x")).toBe("clip");
  vi.runAllTimers();
  expect(c.style.getPropertyValue("overflow-y")).toBe("scroll");
  expect(c.style.getPropertyPriority("overflow-y")).toBe("important");
});

it("restores immediately on dispose and permits a fresh lifecycle", () => {
  const c = setup();
  c.style.setProperty(c.axis, "auto");
  c.prepend();
  c.driver._();
  expect(c.style.getPropertyValue(c.axis)).toBe("auto");
  expect(c.style.getPropertyPriority(c.axis)).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  c.driver.D({}, c.viewport);
  c.prepend(60);
  expect(c.calls.at(-1).overflow).toBe("hidden");
  c.driver._();
  expect(c.style.getPropertyValue(c.axis)).toBe("auto");
});

it("does not overwrite a later style owner", () => {
  const c = setup();
  c.prepend();
  c.style.setProperty(c.axis, "clip", "important");
  vi.runAllTimers();
  expect(c.style.getPropertyValue(c.axis)).toBe("clip");
  expect(c.style.getPropertyPriority(c.axis)).toBe("important");
});

it("interrupts positive and negative resize compensation at the same production driver", () => {
  for (const size of [50, 150]) {
    const c = setup();
    c.store.W(3, [[0, size]]);
    c.driver.J();
    expect(c.calls).toEqual([
      {
        method: "scrollBy",
        options: { top: size - 100, behavior: "instant" },
        overflow: "hidden",
        priority: "important",
      },
    ]);
    c.driver._();
  }
});

it("does not change the imperative scheduler's smooth or instant scrolling policy", async () => {
  for (const smooth of [false, true]) {
    const c = setup();
    c.store.W(
      3,
      Array.from({ length: 20 }, (_, index) => [index, 100]),
    );
    await c.driver.V(() => 900, smooth);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls.at(-1).overflow).toBe("");
    expect(c.calls.at(-1).options).toEqual({
      top: 900,
      behavior: smooth ? "smooth" : "instant",
    });
    c.driver._();
    vi.clearAllTimers();
  }
});

it("takes the absolute path for an integer offset at a fractional end when rows above shrink", () => {
  const c = setup({ platform: "Linux x86_64", offset: 1500 });
  // The last row wraps to a fractional height: the end is 1500.17, and WebKit
  // reports the reader at that bottom as 1500. Nothing above moved yet.
  c.store.W(3, [[19, 100.17]]);
  c.driver.J();
  expect(c.calls).toHaveLength(0);
  // Two rows above the viewport shrink by 80 in total. The browser's integer
  // range ends at 1420; Virtua's fractional end is 1420.17, and the stale
  // 1500 minus 80 falls 0.17 short of it.
  c.viewport.max = 1420;
  c.store.W(3, [
    [1, 60],
    [2, 60],
  ]);
  c.driver.J();
  expect(c.calls).toEqual([
    {
      method: "scrollTo",
      options: { top: 1421, behavior: "instant" },
      overflow: "",
      priority: "",
    },
  ]);
  expect(c.viewport.scrollTop).toBe(1420); // not the clamp plus the shrink again
  c.driver._();
});

it.each([
  ["larger than the reader's gap to the end", 1490, "scrollTo", 1410],
  ["smaller than that gap", 1300, "scrollBy", -80],
])(
  "a shrink %s keeps the reader's content in place",
  (_, offset, method, top) => {
    const c = setup({ platform: "Linux x86_64", offset });
    c.viewport.max = 1420;
    c.store.W(3, [
      [1, 60],
      [2, 60],
    ]);
    c.driver.J();
    expect(c.calls).toEqual([
      {
        method,
        options: { top, behavior: "instant" },
        overflow: "",
        priority: "",
      },
    ]);
    expect(c.viewport.scrollTop).toBe(offset - 80);
    c.driver._();
  },
);

// Twenty measured rows; the first carries 88px of day divider and author
// header above its paragraph, the content a reader at the top of history is
// looking at. Returns that paragraph's viewport position for a row and header.
function openHistory(c) {
  c.store.W(
    3,
    Array.from({ length: 20 }, (_, index) => [index, index ? 100 : 188]),
  );
  c.driver.J();
  expect(c.calls).toEqual([]);
  return (index, header) => c.store.u(index) + header - c.viewport.scrollTop;
}

// A shift compensates every resize until scroll-end, a 150ms timer from its
// jump's own scroll event, but the rows it prepended measure in the frame after
// that jump, together with the former first row, which the same render turned
// into a continuation without its day divider and author header. A late frame
// lets the timer fire first, and native policy keeps the viewport start: the
// former first row sits at that start, so its shrink is dropped, and so is the
// growth of a prepended row whose estimated bottom WebKit's integer offset
// reads short of. live.spec.mjs:194 lost 76px this way on Linux WebKit.
it("a prepend whose rows measure after scroll-end still keeps the former first row's content in place", () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  const paragraph = openHistory(c);
  expect(paragraph(0, 88)).toBe(88);
  c.prepend(40); // 20 older rows at the 100px estimate: the shift jumps 2000
  expect(c.viewport.scrollTop).toBe(2000);
  c.viewport.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(150);
  c.calls.length = 0;
  // The frame measures the prepended rows at 110 (+200 in total) and the former
  // first row, index 20 now, without its header (188 → 100).
  c.store.W(3, [
    ...Array.from({ length: 20 }, (_, index) => [index, 110]),
    [20, 100],
  ]);
  c.driver.J();
  expect(c.calls).toEqual([
    {
      method: "scrollBy",
      options: { top: 112, behavior: "instant" },
      overflow: "",
      priority: "",
    },
  ]);
  expect(paragraph(20, 0)).toBe(88);
  // That batch ended the shift. A visible row growing afterwards (an image
  // loading) keeps the viewport start as before; a row above it is compensated.
  c.calls.length = 0;
  c.store.W(3, [[21, 150]]);
  c.driver.J();
  expect(c.calls).toEqual([]);
  c.store.W(3, [[3, 120]]);
  c.driver.J();
  expect(c.calls.at(-1).options).toEqual({ top: 10, behavior: "instant" });
  c.driver._();
});

it("a deferred shift waits through unrelated and partial measurement batches", () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  openHistory(c);
  c.prepend(40);
  c.viewport.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(150);
  c.calls.length = 0;
  // An unrelated visible row does not satisfy the prepended measurement debt.
  c.store.W(3, [[21, 150]]);
  c.driver.J();
  expect(c.calls.at(-1).options).toEqual({ top: 50, behavior: "instant" });
  // Only part of the mounted prepend measures; visible growth still shifts.
  c.store.W(3, [
    ...Array.from({ length: 19 }, (_, index) => [index, 110]),
    [21, 170],
  ]);
  c.driver.J();
  expect(c.calls.at(-1).options).toEqual({ top: 210, behavior: "instant" });
  // The completing batch must itself receive shift policy, then retire it.
  c.store.W(3, [
    [19, 110],
    [21, 190],
  ]);
  c.driver.J();
  expect(c.calls.at(-1).options).toEqual({ top: 30, behavior: "instant" });
  c.calls.length = 0;
  c.store.W(3, [[22, 150]]);
  c.driver.J();
  expect(c.calls).toEqual([]);
  c.driver._();
});

it("a prepend measured inside the scroll-end window keeps stock shift policy and then returns to native policy", () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  const paragraph = openHistory(c);
  c.prepend(40);
  c.viewport.dispatchEvent(new Event("scroll"));
  c.calls.length = 0;
  c.store.W(3, [
    ...Array.from({ length: 20 }, (_, index) => [index, 110]),
    [20, 100],
  ]);
  c.driver.J();
  expect(c.calls.at(-1).options).toEqual({ top: 112, behavior: "instant" });
  expect(paragraph(20, 0)).toBe(88);
  // Still shifting until scroll-end: a visible row's growth is compensated.
  c.store.W(3, [[21, 150]]);
  c.driver.J();
  expect(c.calls.at(-1).options).toEqual({ top: 50, behavior: "instant" });
  vi.advanceTimersByTime(150);
  c.calls.length = 0;
  c.store.W(3, [[22, 150]]);
  c.driver.J();
  expect(c.calls).toEqual([]);
  c.driver._();
});

it("a prepend whose rows are not mounted ends its shift at scroll-end as before", () => {
  const c = setup({ platform: "Linux x86_64", offset: 1500 });
  c.store.W(
    3,
    Array.from({ length: 20 }, (_, index) => [index, 100]),
  );
  c.driver.J();
  // Virtua's default 200px buffer starts inside the old rows, so no prepended
  // row is mounted and nothing is awaited.
  c.prepend(40, 200);
  expect(c.viewport.scrollTop).toBe(3500);
  c.viewport.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(150);
  c.calls.length = 0;
  c.store.W(3, [[35, 150]]);
  c.driver.J();
  expect(c.calls).toEqual([]);
  // Prepended rows measured later, above the viewport, follow native policy.
  c.store.W(3, [[19, 110]]);
  c.driver.J();
  expect(c.calls.at(-1).options).toEqual({ top: 10, behavior: "instant" });
  c.driver._();
});

// `estimateSize` caches a size known before measurement like a measured one:
// the row renders visible at its predicted offset, and an equal measurement
// is dropped before any state change, so nothing renders or scrolls.
it("seeds unmeasured sizes at creation behind the snapshot, and an equal measurement does nothing", () => {
  const c = setup({
    platform: "Linux x86_64",
    offset: 0,
    cache: [[188, -1], 100],
    estimate: (index) => 50 + index,
  });
  expect([c.store.h(0), c.store.h(1), c.store.h(19)]).toEqual([188, 51, 69]);
  expect(c.store.R(1)).toBe(false);
  expect(c.store.u(3)).toBe(188 + 51 + 52);
  expect(c.store.t()).toBe(1328);
  const notify = vi.fn();
  c.store.H(15, notify);
  const version = c.store.I();
  c.store.W(
    3,
    Array.from({ length: 20 }, (_, index) => [index, index ? 50 + index : 188]),
  );
  c.driver.J();
  expect(c.store.I()).toBe(version);
  expect(notify).not.toHaveBeenCalled();
  expect(c.calls).toEqual([]);
  c.driver._();
});

// The shift-pending wait only covers unmeasured rows, and a predicted prepend
// has none, so the former first row must be re-predicted inside the jump.
it("a predicted prepend jumps by the predicted rows and the former first row's new size", () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  const paragraph = openHistory(c);
  // Twenty older rows predicted at 110 (+200 over the 100px estimate), and the
  // former first row, index 20 now, without its header (188 → 100).
  c.prepend(40, 1600, (index) => (index < 20 ? 110 : 100));
  expect(c.calls).toEqual([
    {
      method: "scrollBy",
      options: { top: 2112, behavior: "instant" },
      overflow: "",
      priority: "",
    },
  ]);
  expect(c.store.R(0)).toBe(false);
  expect(paragraph(20, 0)).toBe(88);
  // Their measurement frame lands after scroll-end and matches: no-op.
  c.viewport.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(150);
  c.calls.length = 0;
  const version = c.store.I();
  c.store.W(3, [
    ...Array.from({ length: 20 }, (_, index) => [index, 110]),
    [20, 100],
  ]);
  c.driver.J();
  expect(c.store.I()).toBe(version);
  expect(c.calls).toEqual([]);
  expect(paragraph(20, 0)).toBe(88);
  c.driver._();
});

it("a shift that removes the first rows re-predicts the row now first inside its jump", () => {
  const estimate = (index) => (index ? 100 : 188);
  const c = setup({ platform: "Linux x86_64", offset: 1000, estimate });
  const reading = c.store.u(5) - c.viewport.scrollTop;
  // The two oldest rows (-288) leave; the row now first gains the day divider
  // and author header (100 → 188).
  c.prepend(18, 1600, estimate);
  expect(c.calls.map(({ method, options }) => [method, options.top])).toEqual([
    ["scrollBy", -200],
  ]);
  expect([c.store.h(0), c.store.t()]).toEqual([188, 1888]);
  expect(c.store.u(3) - c.viewport.scrollTop).toBe(reading);
  c.driver._();
});

it("an append seeds only the new rows, without a jump", () => {
  const c = setup({
    platform: "Linux x86_64",
    offset: 1500,
    estimate: () => 100,
  });
  c.store.W(5, [22, false, (index) => (index < 20 ? 50 : 77)]);
  c.store.i(1600);
  c.driver.J();
  expect(c.calls).toEqual([]);
  expect([c.store.h(19), c.store.h(20), c.store.h(21)]).toEqual([100, 77, 77]);
  expect([c.store.R(21), c.store.t()]).toEqual([false, 2154]);
  c.driver._();
});

// The rows an estimator leaves unknown are the ones that do not resemble the
// rows it seeds, so `itemSize` is only their initial size: the default becomes
// the median of their own measurements, as stock estimates without `itemSize`.
it("with an estimator, unseeded rows take the median measured size of unseeded rows once those exceed the viewport", () => {
  const c = setup({
    platform: "Linux x86_64",
    offset: 0,
    estimate: (index) => (index < 10 ? undefined : 80),
  });
  expect([c.store.h(8), c.store.R(8), c.store.R(10)]).toEqual([
    100,
    true,
    false,
  ]);
  // 7 x 70 = 490px, inside the 500px viewport: not yet.
  c.store.W(3, [
    ...Array.from({ length: 7 }, (_, index) => [index, 70]),
    [10, 80],
  ]);
  expect(c.store.h(8)).toBe(100);
  // The eighth exceeds it. All cached sizes (70 x8, 80 x10) would give 80.
  c.store.W(3, [[7, 70]]);
  expect([c.store.h(8), c.store.h(9), c.store.R(8)]).toEqual([70, 70, true]);
  c.store.W(5, [22, false]); // rows appended later without a seed
  expect(c.store.h(21)).toBe(70);
  c.driver._();
  // Without an estimator, `itemSize` still turns estimation off.
  const stock = setup({ platform: "Linux x86_64", offset: 0 });
  stock.store.W(
    3,
    Array.from({ length: 10 }, (_, index) => [index, 70]),
  );
  expect(stock.store.h(10)).toBe(100);
  stock.driver._();
});

it("without an estimator, automatic estimation still samples every cached size", () => {
  const c = setup({
    platform: "Linux x86_64",
    offset: 0,
    itemSize: 0,
    cache: [Array.from({ length: 10 }, () => 300), 100],
  });
  c.store.W(
    3,
    Array.from({ length: 8 }, (_, index) => [index + 10, 70]),
  );
  // Median of 300 x10 and 70 x8, as stock.
  expect(c.store.h(18)).toBe(300);
  c.driver._();
});

it("with an estimator, the buffer does not wait for automatic estimation", () => {
  const seeded = setup({ offset: 1300, estimate: () => 100 });
  const stock = setup({ offset: 1300 });
  // Exact sizes never complete the estimate, yet the buffer applies as with
  // `itemSize` alone.
  expect(seeded.store.i(200)).toEqual(stock.store.i(200));
  expect(seeded.store.i(200)).not.toEqual(seeded.store.i(0));
  seeded.driver._();
  stock.driver._();
});

it("an imperative resize is not a measurement for automatic estimation", () => {
  const c = setup({
    platform: "Linux x86_64",
    offset: 0,
    estimate: (index) => (index < 10 ? undefined : 80),
  });
  // 8 x 70 = 560px of predictions for unseeded rows: the default stays.
  c.driver.resize(Array.from({ length: 8 }, (_, index) => [index, 70]));
  expect([c.store.h(7), c.store.h(8)]).toEqual([70, 100]);
  c.driver._();
});

it("rows the estimator leaves undefined keep stock sizing, and the shift still waits for them", () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  const paragraph = openHistory(c);
  // The former first row and the ten oldest rows are predicted; the rest keep
  // the 100px estimate, hidden until measured.
  c.prepend(40, 1600, (index) =>
    index < 10 ? 110 : index === 20 ? 100 : undefined,
  );
  expect(c.viewport.scrollTop).toBe(2012);
  expect([c.store.R(9), c.store.R(10), c.store.h(20)]).toEqual([
    false,
    true,
    100,
  ]);
  c.viewport.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(150);
  c.calls.length = 0;
  // The late frame still meets shift policy: +100 above, the top row as seeded.
  c.store.W(3, [
    ...Array.from({ length: 10 }, (_, index) => [index + 10, 110]),
    [20, 100],
  ]);
  c.driver.J();
  expect(c.calls.at(-1).options).toEqual({ top: 100, behavior: "instant" });
  expect(paragraph(20, 0)).toBe(88);
  c.calls.length = 0;
  c.store.W(3, [[21, 150]]); // that batch ended the shift
  c.driver.J();
  expect(c.calls).toEqual([]);
  c.driver._();
});

// Seeding the prepended rows but not the former first row would leave nothing
// unmeasured to wait for, so that row's late shrink would meet native policy.
it("a prepend whose former first row is unknown seeds none of its rows, so the shift waits for their late frame", () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  const paragraph = openHistory(c);
  const asked = [];
  c.prepend(40, 1600, (index) => {
    asked.push(index);
    return index < 20 ? 110 : undefined;
  });
  expect(asked).toEqual([20]);
  expect(c.viewport.scrollTop).toBe(2000);
  expect([c.store.R(0), c.store.R(19), c.store.h(20)]).toEqual([
    true,
    true,
    188,
  ]);
  c.viewport.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(150);
  c.calls.length = 0;
  c.store.W(3, [
    ...Array.from({ length: 20 }, (_, index) => [index, 110]),
    [20, 100],
  ]);
  c.driver.J();
  expect(c.calls.at(-1).options).toEqual({ top: 112, behavior: "instant" });
  expect(paragraph(20, 0)).toBe(88);
  c.driver._();
});

// The handle's `resize` is the measured resize path over predicted sizes.
it("an imperative resize over predicted sizes keeps the measured resize policy", () => {
  for (const [shift, row, size, top] of [
    [false, 2, 150, 30], // wholly above the 1200–1700 viewport
    [false, 9, 100, -20], // ends exactly at the viewport start
    [false, 3, 120, null], // equal to the prediction
    [false, 10, 150, null], // the viewport start is kept
    [false, 12, 150, null], // visible
    [false, 15, 150, null], // below
    [true, 12, 150, 30], // a shift corrects the row at the 1440 start
    [true, 16, 150, 30], // and one starting above the 1940 end
    [true, 17, 150, null], // but not a row below it
  ]) {
    const c = setup({
      platform: "Linux x86_64",
      offset: 1200,
      estimate: () => 120,
    });
    if (shift) {
      c.prepend(22, 1600, () => 120);
      expect(c.viewport.scrollTop).toBe(1440);
      c.viewport.dispatchEvent(new Event("scroll"));
    } else c.store.W(2); // idle
    c.calls.length = 0;
    c.store.W(3, [[row, size]]);
    c.driver.J();
    expect(c.calls.map((call) => call.options.top)).toEqual(
      top === null ? [] : [top],
    );
    c.driver._();
  }
});

it("re-measures only the mounted targets among imperatively resized items", () => {
  const c = setup({ platform: "Linux x86_64", estimate: () => 100 });
  const rows = [10, 11, 12].map((index) => ({ index }));
  const unmount = rows.map((row) => c.driver.P(row, row.index));
  unmount[2]();
  c.observed.length = 0;
  c.driver.resize([
    [2, 120],
    [11, 130],
    [12, 130],
  ]);
  // A re-observed target reports its current size even when unchanged.
  expect(c.observed).toEqual([
    ["unobserve", rows[1]],
    ["observe", rows[1]],
  ]);
  c.driver._();
});

// A mounted row's measurement waits for the next frame. A prediction set in
// between, after a second content change, is newer; the deferred entry must
// not revert it before the re-armed observation reports the current box.
it("a resize drops the row's deferred measurement, so a stale entry cannot revert it", () => {
  const c = setup({ platform: "Linux x86_64", offset: 0, estimate: () => 100 });
  const row = { offsetParent: {} };
  c.driver.P(row, 5);
  c.resize([{ target: row, contentRect: { height: 140 } }]);
  c.observed.length = 0;
  c.driver.resize([[5, 160]]);
  expect(c.store.h(5)).toBe(160);
  c.frame();
  expect(c.store.h(5)).toBe(160);
  expect(c.observed).toEqual([
    ["unobserve", row],
    ["observe", row],
  ]);
  c.driver._();
});

// Like the viewport path: an imperative jump or a correction earlier in this
// frame has moved the native offset, and its scroll event is still queued.
it("a resize reads the native offset first, so a row above a jump that precedes its event is compensated", () => {
  const c = setup({
    platform: "Linux x86_64",
    offset: 600,
    estimate: () => 100,
  });
  c.store.W(2); // idle
  c.viewport.scrollTop = 1000;
  c.calls.length = 0;
  // Row 7 (700–800) is wholly above the new start, not the stale one.
  c.driver.resize([[7, 150]]);
  c.driver.J();
  expect(c.store.T()).toBe(1000);
  expect(c.calls.map(({ method, options }) => [method, options.top])).toEqual([
    ["scrollBy", 50],
  ]);
  expect(c.viewport.scrollTop).toBe(1050);
  c.driver._();
});

// The app resizes changed rows after a commit. A prepend whose former first
// row is unknown left its rows unmeasured; a same-commit content change below
// must neither seed them nor end the shift that waits for them.
it("a resize after a withheld prepend keeps its shift waiting for the late frame", () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  const paragraph = openHistory(c);
  c.prepend(40, 1600, (index) => (index < 20 ? 110 : undefined));
  // The jump's scroll event has not arrived yet.
  c.driver.resize([[35, 150]]);
  c.driver.J();
  expect([c.store.R(0), c.store.R(19), c.store.h(35)]).toEqual([
    true,
    true,
    150,
  ]);
  // Row 20 still holds its 188px size with the 88px header.
  expect(paragraph(20, 88)).toBe(88);
  c.viewport.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(150);
  c.calls.length = 0;
  c.store.W(3, [
    ...Array.from({ length: 20 }, (_, index) => [index, 110]),
    [20, 100],
  ]);
  c.driver.J();
  expect(c.calls.at(-1).options).toEqual({ top: 112, behavior: "instant" });
  expect(paragraph(20, 0)).toBe(88);
  c.driver._();
});

for (const [name, config, deferred] of [
  ["macOS Chrome", { vendor: "Google Inc." }, false],
  ["macOS Firefox", { vendor: "" }, false],
  ["Linux WebKit", { platform: "Linux x86_64" }, false],
  ["desktop-mode iPad", { touch: 5 }, true],
  ["iPhone", { platform: "iPhone", agent: "iPhone", touch: 5 }, true],
]) {
  it(`preserves existing ${name} policy`, () => {
    const c = setup(config);
    c.prepend();
    expect(c.calls).toHaveLength(deferred ? 0 : 1);
    if (deferred) {
      c.store.W(2);
      c.driver.J();
    }
    expect(c.calls.at(-1).overflow).toBe("");
    expect(c.store.t()).toBe(4000);
    c.driver._();
  });
}

function resizeHarness() {
  let notify;
  let nextFrame = 0;
  const frames = new Map();
  const view = {
    ResizeObserver: class {
      constructor(callback) {
        notify = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
  };
  const received = [];
  const observer = new Function(`${core};return C;`)()((entries) =>
    received.push(entries),
  );
  const node = () => ({ ownerDocument: { defaultView: view } });
  return {
    observer,
    received,
    frames,
    node,
    notify(entries) {
      notify(entries);
    },
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
  };
}

it("delivers the latest resize per target outside native observer delivery", () => {
  const h = resizeHarness();
  const first = h.node(),
    second = h.node();
  h.observer.A(first);
  h.observer.A(second);
  h.notify([{ target: first, contentRect: { height: 40 } }]);
  const latest = { target: first, contentRect: { height: 60 } };
  const other = { target: second, contentRect: { height: 80 } };
  h.notify([latest, other]);
  expect(h.received).toEqual([]);
  expect(h.frames.size).toBe(1);
  h.flush();
  expect(h.received).toEqual([[latest, other]]);
  expect(h.frames.size).toBe(0);
});

it("delivers a viewport resize during native delivery and still defers item resizes", () => {
  const h = resizeHarness();
  const viewport = h.node(),
    item = h.node();
  h.observer.A(viewport, true);
  h.observer.A(item);
  const size = { target: viewport, contentRect: { height: 500 } };
  const row = { target: item, contentRect: { height: 40 } };
  h.notify([size, row]);
  // Item rendering stays outside native delivery; the viewport mounts only
  // deeper rows, and deferring it would cost a frame before any row paints.
  expect(h.received).toEqual([[size]]);
  expect(h.frames.size).toBe(1);
  h.flush();
  expect(h.received).toEqual([[size], [row]]);
  h.observer.B(viewport);
  h.notify([size]);
  h.flush();
  expect(h.received).toEqual([[size], [row]]);
  h.observer.X();
  h.observer.A(viewport);
  h.notify([size]);
  expect(h.received).toEqual([[size], [row]]);
  h.flush();
  expect(h.received).toEqual([[size], [row], [size]]);
});

it.each([
  ["ltr", {}],
  ["rtl", { horizontal: true, direction: "rtl" }],
])(
  "renders the first %s viewport range at a scroll that precedes its event",
  (_, config) => {
    const c = setup(config);
    const key = config.horizontal ? "scrollLeft" : "scrollTop";
    const native = config.direction === "rtl" ? -1 : 1;
    // An imperative jump wrote the native offset; its scroll event is queued.
    c.viewport[key] = 1700 * native;
    c.resize([
      { target: c.viewport, contentRect: { height: 600, width: 600 } },
    ]);
    expect(c.store.T()).toBe(1700);
    expect(c.store.o()).toBe(600);
    const [first, last] = c.store.i(0);
    expect(first).toBe(17);
    expect(last).toBeGreaterThanOrEqual(19);
    // The queued event then carries no new offset.
    c.viewport.dispatchEvent(new Event("scroll"));
    expect(c.store.T()).toBe(1700);
    c.driver._();
  },
);

it("drops retired targets, cancels pending delivery on disposal, and can remount", () => {
  const h = resizeHarness();
  const first = h.node(),
    second = h.node();
  h.observer.A(first);
  h.observer.A(second);
  const retained = { target: second, contentRect: { height: 80 } };
  h.notify([{ target: first }, retained]);
  h.observer.B(first);
  h.flush();
  expect(h.received).toEqual([[retained]]);
  h.notify([retained]);
  h.observer.X();
  expect(h.frames.size).toBe(0);
  h.notify([retained]); // A native callback already queued at disposal is stale.
  h.flush();
  expect(h.received).toEqual([[retained]]);
  h.observer.A(first);
  const remounted = { target: first, contentRect: { height: 100 } };
  h.notify([remounted]);
  h.flush();
  expect(h.received).toEqual([[retained], [remounted]]);
});

// The timer stays at zero: measurement delivery is explicitly inside the
// retained command's 150ms lifetime, not after an input-settle helper expires it.
it.each(["wheel", "touchmove", "keydown", "pointerdown"])(
  "%s retires a pending imperative target before late measurement",
  async (type) => {
    const c = setup({ platform: "Linux x86_64", offset: 0 });
    c.store.W(
      3,
      Array.from({ length: 20 }, (_, index) => [index, 100]),
    );
    await c.driver.V(() => c.store.u(19) + c.store.h(19) - c.store.o(), false);
    expect(c.viewport.scrollTop).toBe(1500);
    c.viewport.dispatchEvent(Object.assign(new Event(type), { deltaY: -500 }));
    c.viewport.scrollTop = 1000;
    c.viewport.dispatchEvent(new Event("scroll"));
    c.calls.length = 0;
    c.store.W(5, [21, false]);
    c.store.W(3, [[20, 120]]);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.viewport.scrollTop).toBe(1000);
    expect(c.calls).toEqual([]);
    // A fresh navigation still owns its target and corrects later measurements.
    await c.driver.V(() => c.store.t() - c.store.o(), false);
    c.store.W(3, [[20, 140]]);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.viewport.scrollTop).toBe(1640);
    c.driver._();
  },
);

it.each(["input", "dispose"])(
  "%s invalidates an already queued imperative measurement replay",
  async (cancel) => {
    const c = setup({ platform: "Linux x86_64", offset: 0 });
    await c.driver.V(() => 1500, false);
    c.calls.length = 0;
    c.store.W(3, [[19, 120]]); // queue the replay, but do not run it yet
    if (cancel === "input") c.viewport.dispatchEvent(new Event("wheel"));
    else c.driver._();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls).toEqual([]);
    if (cancel === "input") c.driver._();
  },
);

it("removes cancellation listeners on disposal and reattaches on remount", async () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  const remove = vi.spyOn(c.viewport, "removeEventListener");
  c.driver._();
  for (const type of ["wheel", "touchmove", "keydown", "pointerdown"])
    expect(remove).toHaveBeenCalledWith(type, expect.any(Function), true);
  c.driver.D({}, c.viewport);
  await c.driver.V(() => 1500, false);
  c.viewport.dispatchEvent(new Event("wheel"));
  c.calls.length = 0;
  c.store.W(3, [[19, 120]]);
  await vi.advanceTimersByTimeAsync(0);
  expect(c.calls).toEqual([]);
  c.driver._();
});
