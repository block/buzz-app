// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The installed Virtualizer owns `estimateSize` and the handle's `resize`,
// outside the store/driver extraction virtua-compensation.test.mjs evaluates.
// jsdom has no layout: the observer and scroll methods are stubbed, and the
// viewport size is delivered by hand.
type Entry = {
  target: Element;
  contentRect: { width: number; height: number };
};
type Predict = (row: string | undefined, index: number) => number | undefined;
const observers: Observer[] = [];
class Observer {
  readonly log: [string, string | null][] = [];
  constructor(readonly notify: (entries: Entry[]) => void) {
    observers.push(this);
  }
  observe(target: Element) {
    this.log.push(["observe", target.textContent]);
  }
  unobserve(target: Element) {
    this.log.push(["unobserve", target.textContent]);
  }
  disconnect() {}
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", Observer);
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
    document.body,
  );
  for (const [method, relative] of [
    ["scrollBy", true],
    ["scrollTo", false],
  ] as const)
    Object.defineProperty(HTMLElement.prototype, method, {
      configurable: true,
      value(this: HTMLElement, { top = 0 }: ScrollToOptions) {
        this.scrollTop = (relative ? this.scrollTop : 0) + top;
      },
    });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const method of ["scrollBy", "scrollTo"])
    Reflect.deleteProperty(HTMLElement.prototype, method);
});

function List({
  rows,
  handle,
  predict,
  shift = false,
}: {
  rows: readonly string[];
  handle: RefObject<VirtualizerHandle | null>;
  predict: Predict;
  shift?: boolean;
}) {
  return (
    <div id="scroller" style={{ overflowY: "auto", height: 500 }}>
      <Virtualizer
        ref={handle}
        itemSize={100}
        shift={shift}
        estimateSize={(index) => predict(rows[index], index)}
      >
        {rows.map((row) => (
          <p key={row}>{row}</p>
        ))}
      </Virtualizer>
    </div>
  );
}

function mount(rows: readonly string[], predict: Predict) {
  const handle = createRef<VirtualizerHandle>();
  const view = render(<List rows={rows} handle={handle} predict={predict} />);
  const scroller = view.container.querySelector<HTMLElement>("#scroller");
  if (!scroller) throw new Error("scroller missing");
  act(() =>
    observers[0]?.notify([
      { target: scroller, contentRect: { width: 300, height: 500 } },
    ]),
  );
  const items = () =>
    [
      ...view.container.querySelectorAll<HTMLElement>("#scroller > div > div"),
    ].map((item) => [item.textContent, item.style.top, item.style.visibility]);
  return { ...view, handle, scroller, items };
}

it("renders predicted rows visible at their offsets, and a shift re-predicts with that render's rows", () => {
  // The first row carries a 40px day divider and author header.
  const predict: Predict = (row, index) => 50 + Number(row) + (index ? 0 : 40);
  const rows = Array.from({ length: 10 }, (_, index) => String(index + 10));
  const view = mount(rows, predict);
  // The first ranged commit, before any row measurement.
  expect(view.items().slice(0, 3)).toEqual([
    ["10", "0px", ""],
    ["11", "100px", ""],
    ["12", "161px", ""],
  ]);
  view.rerender(
    <List
      rows={["8", "9", ...rows]}
      handle={view.handle}
      predict={predict}
      shift
    />,
  );
  // "10" lost its header (100 → 60) inside the same end-anchored jump.
  expect(view.handle.current?.getItemSize(2)).toBe(60);
  expect(view.handle.current?.getItemOffset(2)).toBe(98 + 59);
  expect(view.scroller.scrollTop).toBe(98 + 59 - 40);
  expect(view.items().slice(0, 3)).toEqual([
    ["8", "0px", ""],
    ["9", "98px", ""],
    ["10", "157px", ""],
  ]);
});

it("handle.resize compensates a row above and re-measures a mounted one", () => {
  const rows = Array.from({ length: 100 }, (_, index) => String(index));
  const view = mount(rows, () => 100);
  view.scroller.scrollTop = 5000;
  act(() => view.scroller.dispatchEvent(new Event("scroll")));
  expect(view.items().map(([row]) => row)).toContain("55");
  const log = observers[0]?.log ?? [];
  log.length = 0;
  act(() =>
    view.handle.current?.resize([
      [10, 150],
      [55, 130],
    ]),
  );
  expect(view.scroller.scrollTop).toBe(5050);
  expect(view.handle.current?.getItemOffset(56)).toBe(5680);
  // The synchronous render unmounts "57"; mounted "55" is re-observed so its
  // real size confirms or corrects the value.
  expect(log).toEqual([
    ["unobserve", "57"],
    ["unobserve", "55"],
    ["observe", "55"],
  ]);
});
