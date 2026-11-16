// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/dom";
import {
  observeMessageActionHover,
  inToolbarRoute,
  MESSAGE_ACTION_TRAVEL_IDLE_MS,
} from "./messageActionHover";
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});
const point = (x: number, y: number) => ({
  clientX: x,
  clientY: y,
  pointerType: "mouse",
});
function setup() {
  const scope = document.createElement("div");
  scope.setAttribute("data-message-scroller", "");
  document.body.append(scope);
  const cleanups: (() => void)[] = [];
  function row(id: string) {
    const node = document.createElement("div");
    const content = document.createElement("span");
    const bar = document.createElement("div");
    node.dataset.messageId = id;
    node.append(content, bar);
    scope.append(node);
    vi.spyOn(bar, "matches").mockImplementation(
      (selector: string) => selector === ":popover-open",
    );
    bar.getBoundingClientRect = () => new DOMRect(180, 100, 100, 40);
    const changed = vi.fn();
    cleanups.push(
      observeMessageActionHover(
        {
          row: node,
          bar,
          hit: (target) =>
            target instanceof Element &&
            !target.closest(
              "[data-message-reactions], [data-media-timecode]",
            ) &&
            node.contains(target),
          retain: () => false,
          changed,
        },
        false,
      ),
    );
    return { node, content, bar, changed };
  }
  const a = row("a"),
    b = row("b");
  fireEvent.pointerMove(a.content, point(100, 200));
  return {
    a,
    b,
    scope,
    close: () =>
      cleanups.forEach((stop) => {
        stop();
      }),
  };
}
it.each([
  "pause",
  "reverse",
  "press",
  "scroll",
  "cancel",
  "blur",
  "unmount",
  "touch",
])("protects travel and releases ownership on %s", (action) => {
  vi.useFakeTimers();
  const { a, b, scope, close } = setup();
  try {
    fireEvent.pointerMove(b.content, point(150, 160));
    expect(a.changed).toHaveBeenLastCalledWith(true);
    expect(b.changed).not.toHaveBeenCalled();
    if (action === "pause") {
      vi.advanceTimersByTime(MESSAGE_ACTION_TRAVEL_IDLE_MS - 1);
      expect(b.changed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(b.changed).toHaveBeenLastCalledWith(true);
    }
    if (action === "reverse") {
      fireEvent.pointerMove(b.content, point(140, 170));
      expect(b.changed).toHaveBeenLastCalledWith(true);
    }
    if (action === "press") {
      fireEvent.pointerDown(b.content, point(150, 160));
      expect(b.changed).toHaveBeenLastCalledWith(true);
    }
    if (action === "scroll") fireEvent.scroll(scope);
    if (action === "touch")
      fireEvent.pointerDown(b.content, {
        ...point(150, 160),
        pointerType: "touch",
      });
    if (action === "cancel") fireEvent.pointerCancel(document);
    if (action === "blur") fireEvent(window, new Event("blur"));
    if (action === "unmount") {
      close();
      vi.runAllTimers();
      expect(vi.getTimerCount()).toBe(0);
      return;
    }
    expect(a.changed).toHaveBeenLastCalledWith(false);
  } finally {
    close();
  }
});
it("keeps slow progress and toolbar interaction, then releases on leaving the surface", () => {
  vi.useFakeTimers();
  const { a, b, close } = setup();
  try {
    for (const [x, y] of [
      [150, 160],
      [160, 155],
      [170, 150],
    ] as const) {
      fireEvent.pointerMove(b.content, point(x, y));
      vi.advanceTimersByTime(100);
      expect(b.changed).not.toHaveBeenCalled();
    }
    fireEvent.pointerMove(a.bar, point(200, 120));
    vi.advanceTimersByTime(1000);
    expect(a.changed).toHaveBeenLastCalledWith(true);
    fireEvent.pointerMove(document.body, point(0, 0));
    expect(a.changed).toHaveBeenLastCalledWith(false);
  } finally {
    close();
  }
});
it("retains routes toward a toolbar above, below, left, or right without covering unrelated space", () => {
  const box = new DOMRect(100, 100, 100, 40);
  for (const origin of [
    { x: 150, y: 250 },
    { x: 150, y: 0 },
    { x: 0, y: 120 },
    { x: 300, y: 120 },
  ]) {
    expect(
      inToolbarRoute(
        { x: (origin.x + 150) / 2, y: (origin.y + 120) / 2 },
        origin,
        box,
      ),
    ).toBe(true);
    expect(inToolbarRoute({ x: -200, y: -200 }, origin, box)).toBe(false);
  }
});

it.each(["data-message-reactions", "data-media-timecode"])(
  "protects travel across a neighbor's %s without activating its controls",
  (attribute) => {
    vi.useFakeTimers();
    const { a, b, close } = setup();
    const control = document.createElement("button");
    control.setAttribute(attribute, "");
    b.node.append(control);
    try {
      fireEvent.pointerMove(control, point(150, 160));
      expect(a.changed).toHaveBeenLastCalledWith(true);
      expect(b.changed).not.toHaveBeenCalled();
      fireEvent.pointerMove(a.bar, point(200, 120));
      vi.advanceTimersByTime(MESSAGE_ACTION_TRAVEL_IDLE_MS);
      expect(a.changed).toHaveBeenLastCalledWith(true);
      fireEvent.pointerMove(a.content, point(100, 200));
      fireEvent.pointerMove(control, point(150, 160));
      vi.advanceTimersByTime(MESSAGE_ACTION_TRAVEL_IDLE_MS);
      expect(a.changed).toHaveBeenLastCalledWith(false);
      expect(b.changed).not.toHaveBeenCalled();
      fireEvent.pointerMove(a.content, point(100, 200));
      fireEvent.pointerMove(control, point(150, 160));
      fireEvent.pointerDown(control, point(150, 160));
      expect(a.changed).toHaveBeenLastCalledWith(false);
      expect(b.changed).not.toHaveBeenCalled();
    } finally {
      close();
    }
  },
);
