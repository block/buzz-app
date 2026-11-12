// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { smoothWheelPreference } from "./smooth-wheel-preference";
import {
  LINE_PX,
  forwardWheel,
  isMouseWheel,
  smoothWheel,
  toPixels,
  useWheelSmoothing,
} from "./wheel-smoothing";

// Deltas Buzz's WebKit reported on macOS. A mouse notch is a 16.16 fixed-point
// line count times 40px; the trackpad sends whole pixels about every 16ms.
const NOTCH = 4.000244140625; // 6554 / 65536 x 40
const UPWARD = -56.8939208984375;
const ACCELERATED = [UPWARD, 34.415283203125, 109.986572265625];
const TRACKPAD = [1, 2, 3];

/** requestAnimationFrame that only runs when the test advances the clock. */
function fakeFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 1;
  let now = 1000;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(next, callback);
    return next++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const tick = (ms = 16) => {
    now += ms;
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(now);
  };
  return {
    tick,
    pending: () => frames.size,
    /** Runs frames until nothing is scheduled; returns how many ran. */
    settle(limit = 1000) {
      let count = 0;
      while (frames.size && count < limit) {
        tick();
        count++;
      }
      if (frames.size) throw new Error("frames never settled");
      return count;
    },
  };
}

let frames: ReturnType<typeof fakeFrames>;
/** The timeline's reader intent; its own wheel handler bumps it per wheel. */
let intent = 0;
let uninstall: (() => void) | undefined;

/**
 * A channel timeline with the scroll geometry jsdom doesn't lay out. Like a
 * browser, scrollTop clamps to the scroll range. Its app root's bubbling wheel
 * handler stands in for React's, which runs ChannelTimeline's onWheel gesture.
 */
function fakeTimeline({
  scrollTop = 1000,
  scrollHeight = 5000,
  clientHeight = 600,
} = {}) {
  const timeline = document.createElement("section");
  const row = document.createElement("div");
  const text = document.createElement("p");
  text.textContent = "Fictional message";
  row.append(text);
  timeline.append(row);
  let top = scrollTop;
  Object.defineProperties(timeline, {
    scrollHeight: { get: () => scrollHeight },
    clientHeight: { get: () => clientHeight },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(scrollHeight - clientHeight, value));
      },
    },
  });
  const root = document.createElement("div");
  root.addEventListener("wheel", () => intent++);
  root.append(timeline);
  document.body.append(root);
  return { timeline, row, text };
}

function install(timeline: HTMLElement) {
  uninstall = smoothWheel(timeline, () => intent);
}

type WheelOptions = {
  deltaY?: number;
  deltaX?: number;
  deltaMode?: number;
  cancelable?: boolean;
} & Pick<MouseEventInit, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

/** Dispatches a wheel; true when WebKit's own scroll was prevented. */
function wheel(target: Element, options: WheelOptions) {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function reducedMotion(matches: boolean) {
  const query = { matches };
  vi.stubGlobal("matchMedia", () => query);
  return query;
}

beforeEach(() => {
  frames = fakeFrames();
  intent = 0;
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  cleanup();
  document.body.innerHTML = "";
  smoothWheelPreference.set(true);
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("telling a mouse from a trackpad", () => {
  it("reads WebKit's fixed-point notch deltas as a mouse wheel", () => {
    for (const deltaY of [NOTCH, ...ACCELERATED]) {
      // Each is an exact multiple of 40/65536, which is why it is fractional.
      expect(Number.isInteger((deltaY * 65536) / LINE_PX)).toBe(true);
      expect(isMouseWheel({ deltaMode: 0, deltaX: 0, deltaY })).toBe(true);
    }
  });

  it("reads whole-pixel deltas as a trackpad", () => {
    for (const deltaY of TRACKPAD)
      expect(isMouseWheel({ deltaMode: 0, deltaX: 0, deltaY })).toBe(false);
    expect(isMouseWheel({ deltaMode: 0, deltaX: -2, deltaY: 0 })).toBe(false);
  });

  it("counts line and page delta modes as a wheel and converts them to pixels", () => {
    const element = { clientHeight: 600 } as Element;
    expect(isMouseWheel({ deltaMode: 1, deltaX: 0, deltaY: 3 })).toBe(true);
    expect(isMouseWheel({ deltaMode: 2, deltaX: 0, deltaY: 1 })).toBe(true);
    expect(toPixels({ deltaMode: 1, deltaX: 0, deltaY: 3 }, element)).toBe(120);
    expect(toPixels({ deltaMode: 2, deltaX: 0, deltaY: -1 }, element)).toBe(
      -600,
    );
    expect(toPixels({ deltaMode: 0, deltaX: 0, deltaY: NOTCH }, element)).toBe(
      NOTCH,
    );
  });
});

describe("gliding", () => {
  it("prevents a mouse notch and glides the whole distance over several frames", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    expect(wheel(text, { deltaY: NOTCH })).toBe(true);
    for (let notch = 0; notch < 4; notch++)
      expect(wheel(text, { deltaY: 109.986572265625 })).toBe(true);
    expect(timeline.scrollTop).toBe(1000);
    frames.tick();
    expect(timeline.scrollTop).toBeGreaterThan(1000);
    expect(timeline.scrollTop).toBeLessThan(1200);
    expect(frames.settle()).toBeGreaterThan(5);
    expect(timeline.scrollTop).toBeCloseTo(1000 + NOTCH + 4 * 109.986572265625);
    expect(Math.floor(timeline.scrollTop)).toBe(1443);
  });

  it("glides upward too", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    expect(wheel(text, { deltaY: UPWARD })).toBe(true);
    frames.settle();
    expect(timeline.scrollTop).toBeCloseTo(1000 + UPWARD);
  });

  it("eases line-mode notches by 40px a line", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    expect(wheel(text, { deltaY: 3, deltaMode: 1 })).toBe(true);
    frames.settle();
    expect(timeline.scrollTop).toBeCloseTo(1120);
  });

  it("settles a notch in about the glide time", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    wheel(text, { deltaY: 200.5 });
    // 140ms of 16ms frames moves all but e^-3 (5%) of the notch.
    for (let frame = 0; frame < 9; frame++) frames.tick();
    expect(timeline.scrollTop - 1000).toBeGreaterThan(190);
    expect(frames.pending()).toBe(1);
  });

  it("keeps the timeline's own scrollTop correction made during a glide", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    wheel(text, { deltaY: 200.5 });
    frames.tick();
    frames.tick();
    // Rows above the viewport grew, so the timeline moved itself to hold its place.
    timeline.scrollTop += 100;
    frames.settle();
    expect(timeline.scrollTop).toBeCloseTo(1300.5);
  });

  it("stops at the bottom edge", () => {
    const { timeline, text } = fakeTimeline({ scrollTop: 4300 });
    install(timeline);
    wheel(text, { deltaY: 200.5 });
    frames.settle();
    expect(timeline.scrollTop).toBe(4400);
    expect(frames.pending()).toBe(0);
  });

  it("stops at the top edge", () => {
    const { timeline, text } = fakeTimeline({ scrollTop: 50 });
    install(timeline);
    wheel(text, { deltaY: -200.5 });
    frames.settle();
    expect(timeline.scrollTop).toBe(0);
  });

  it("restarts from where it is when the wheel turns the other way", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    wheel(text, { deltaY: 200.5 });
    frames.tick();
    const turned = timeline.scrollTop;
    wheel(text, { deltaY: -100.25 });
    frames.settle();
    expect(timeline.scrollTop).toBeCloseTo(turned - 100.25);
  });
});

describe("ending a glide", () => {
  it("stops when the trackpad takes over", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    wheel(text, { deltaY: 200.5 });
    frames.tick();
    const at = timeline.scrollTop;
    expect(wheel(text, { deltaY: 2 })).toBe(false);
    frames.tick();
    expect(frames.pending()).toBe(0);
    expect(timeline.scrollTop).toBe(at);
  });

  it("stops on newer reader intent: a press, a key, a send, a jump or a reveal", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    wheel(text, { deltaY: 200.5 });
    frames.tick();
    frames.tick();
    const at = timeline.scrollTop;
    intent++;
    frames.tick();
    expect(frames.pending()).toBe(0);
    expect(timeline.scrollTop).toBe(at);
  });

  it("adopts the intent its own notches raise, even before the first frame", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    wheel(text, { deltaY: 100.25 });
    wheel(text, { deltaY: 100.25 });
    frames.tick();
    wheel(text, { deltaY: 100.25 });
    frames.settle();
    expect(timeline.scrollTop).toBeCloseTo(1300.75);
  });

  it("stops on reader intent newer than its notch, even before the first frame", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    wheel(text, { deltaY: -200.5 });
    intent++;
    frames.tick();
    expect(frames.pending()).toBe(0);
    expect(timeline.scrollTop).toBe(1000);
  });

  it("drops motion a newer intent ended when another notch follows before a frame", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    wheel(text, { deltaY: -200.5 });
    intent++;
    wheel(text, { deltaY: -100.25 });
    frames.settle();
    expect(timeline.scrollTop).toBeCloseTo(899.75);
  });

  it("still glides a notch whose propagation stopped short of the app root", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    timeline.addEventListener("wheel", (event) => event.stopPropagation());
    wheel(text, { deltaY: 100.25 });
    frames.settle();
    expect(timeline.scrollTop).toBeCloseTo(1100.25);
  });

  it("stops when Reduce motion comes on", () => {
    const motion = reducedMotion(false);
    const { timeline, text } = fakeTimeline();
    install(timeline);
    wheel(text, { deltaY: 200.5 });
    frames.tick();
    motion.matches = true;
    const at = timeline.scrollTop;
    frames.tick();
    expect(frames.pending()).toBe(0);
    expect(timeline.scrollTop).toBe(at);
  });

  it("stops and stops handling wheels once removed", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    wheel(text, { deltaY: 200.5 });
    frames.tick();
    const at = timeline.scrollTop;
    uninstall?.();
    uninstall = undefined;
    expect(frames.pending()).toBe(0);
    expect(wheel(text, { deltaY: NOTCH })).toBe(false);
    expect(forwardWheel(timeline, new WheelEvent("wheel"))).toBe(false);
    frames.tick();
    expect(timeline.scrollTop).toBe(at);
  });
});

describe("leaving input alone", () => {
  it("lets trackpad scrolling through", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    for (const deltaY of TRACKPAD) expect(wheel(text, { deltaY })).toBe(false);
    expect(frames.pending()).toBe(0);
    expect(timeline.scrollTop).toBe(1000);
  });

  it("lets a notch through at the edge it pushes against, or when nothing scrolls", () => {
    const bottom = fakeTimeline({ scrollTop: 4400 });
    install(bottom.timeline);
    expect(wheel(bottom.text, { deltaY: NOTCH })).toBe(false);
    expect(wheel(bottom.text, { deltaY: -NOTCH })).toBe(true);
    uninstall?.();
    const top = fakeTimeline({ scrollTop: 0 });
    install(top.timeline);
    expect(wheel(top.text, { deltaY: -NOTCH })).toBe(false);
    uninstall?.();
    const short = fakeTimeline({
      scrollTop: 0,
      scrollHeight: 600,
      clientHeight: 600,
    });
    install(short.timeline);
    expect(wheel(short.text, { deltaY: NOTCH })).toBe(false);
  });

  it("skips modifier keys, horizontal input and zero vertical deltas", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    for (const key of ["ctrlKey", "metaKey", "shiftKey", "altKey"] as const)
      expect(wheel(text, { deltaY: NOTCH, [key]: true })).toBe(false);
    expect(wheel(text, { deltaX: 20.5, deltaY: NOTCH })).toBe(false);
    expect(wheel(text, { deltaX: 4.5, deltaY: 0 })).toBe(false);
    expect(frames.pending()).toBe(0);
  });

  it("skips wheels it cannot prevent or that an inner handler already took", () => {
    const { timeline, text } = fakeTimeline();
    install(timeline);
    expect(wheel(text, { deltaY: NOTCH, cancelable: false })).toBe(false);
    text.addEventListener("wheel", (event) => event.preventDefault(), {
      once: true,
    });
    wheel(text, { deltaY: NOTCH });
    expect(frames.pending()).toBe(0);
  });

  it("leaves a scrollable element inside the timeline to scroll itself", () => {
    const { timeline, row } = fakeTimeline();
    install(timeline);
    const code = document.createElement("pre");
    code.style.overflowY = "auto";
    Object.defineProperties(code, {
      scrollHeight: { get: () => 500 },
      clientHeight: { get: () => 100 },
    });
    row.append(code);
    expect(wheel(code, { deltaY: NOTCH })).toBe(false);
    // One with nothing to scroll is ordinary content.
    const short = document.createElement("pre");
    short.style.overflowY = "auto";
    row.append(short);
    expect(wheel(short, { deltaY: NOTCH })).toBe(true);
  });

  it.each([
    ["a modal dialog", () => document.createElement("dialog")],
    [
      "a dialog role",
      () => {
        const node = document.createElement("div");
        node.setAttribute("role", "dialog");
        return node;
      },
    ],
    [
      "an aria-modal surface",
      () => {
        const node = document.createElement("div");
        node.setAttribute("aria-modal", "true");
        return node;
      },
    ],
  ])("leaves wheels over %s inside a message alone", (_name, create) => {
    const { timeline, row } = fakeTimeline();
    install(timeline);
    // Such as a plugin's expanded equation: short content, header, footer.
    const overlay = create();
    const button = document.createElement("button");
    overlay.append(button);
    row.append(overlay);
    expect(wheel(button, { deltaY: NOTCH })).toBe(false);
    expect(wheel(overlay, { deltaY: -NOTCH })).toBe(false);
    expect(frames.pending()).toBe(0);
  });
});

describe("the floating message toolbar", () => {
  // A top-layer popover inside the row. Open, it is outside the timeline's
  // native scroll chain, so useFloatingActionBar forwards its wheels: through
  // forwardWheel first, otherwise with an instant scrollBy.
  function toolbar(row: Element, timeline: HTMLElement, open = true) {
    const bar = document.createElement("div");
    bar.setAttribute("popover", "manual");
    const button = document.createElement("button");
    bar.append(button);
    row.append(bar);
    vi.spyOn(bar, "matches").mockImplementation((selector) =>
      selector === ":popover-open"
        ? open
        : Element.prototype.matches.call(bar, selector),
    );
    bar.addEventListener("wheel", (event) => {
      if (!open || forwardWheel(timeline, event)) return;
      event.preventDefault();
      timeline.scrollTop += event.deltaY;
    });
    return button;
  }

  it("glides a notch over an open toolbar once", () => {
    const { timeline, row } = fakeTimeline();
    install(timeline);
    const button = toolbar(row, timeline);
    expect(wheel(button, { deltaY: 200.5 })).toBe(true);
    expect(timeline.scrollTop).toBe(1000);
    frames.tick();
    expect(timeline.scrollTop).toBeLessThan(1150);
    frames.settle();
    expect(timeline.scrollTop).toBeCloseTo(1200.5);
  });

  it("turns a glide around over the toolbar without a jump in the old direction", () => {
    const { timeline, row } = fakeTimeline();
    install(timeline);
    const button = toolbar(row, timeline);
    wheel(button, { deltaY: 200.5 });
    // Reversed before any frame, as when frame delivery is delayed.
    wheel(button, { deltaY: -100.25 });
    expect(timeline.scrollTop).toBe(1000);
    frames.tick();
    expect(timeline.scrollTop).toBeLessThan(1000);
    frames.settle();
    expect(timeline.scrollTop).toBeCloseTo(899.75);
  });

  it("adds toolbar notches to a glide already running", () => {
    const { timeline, row, text } = fakeTimeline();
    install(timeline);
    const button = toolbar(row, timeline);
    wheel(text, { deltaY: 100.25 });
    frames.tick();
    wheel(button, { deltaY: 100.25 });
    frames.tick();
    wheel(button, { deltaY: 100.25 });
    frames.settle();
    expect(timeline.scrollTop).toBeCloseTo(1300.75);
  });

  it("leaves trackpad input over the toolbar to its own forwarding", () => {
    const { timeline, row } = fakeTimeline();
    install(timeline);
    const button = toolbar(row, timeline);
    expect(wheel(button, { deltaY: 3 })).toBe(true);
    expect(timeline.scrollTop).toBe(1003);
    expect(frames.pending()).toBe(0);
  });

  it("forwards nothing for a scroller without smoothing", () => {
    const { timeline, row } = fakeTimeline();
    const button = toolbar(row, timeline);
    expect(wheel(button, { deltaY: 200.5 })).toBe(true);
    expect(timeline.scrollTop).toBeCloseTo(1200.5);
    expect(frames.pending()).toBe(0);
  });

  it("glides over a closed toolbar like any other content", () => {
    const { timeline, row } = fakeTimeline();
    install(timeline);
    const button = toolbar(row, timeline, false);
    expect(wheel(button, { deltaY: 200.5 })).toBe(true);
    frames.settle();
    expect(timeline.scrollTop).toBeCloseTo(1200.5);
  });

  it("leaves other open popovers in a message, such as a hover card, alone", () => {
    const { timeline, row } = fakeTimeline();
    install(timeline);
    const card = document.createElement("div");
    card.setAttribute("popover", "manual");
    const link = document.createElement("a");
    card.append(link);
    row.append(card);
    vi.spyOn(card, "matches").mockReturnValue(true);
    expect(wheel(link, { deltaY: NOTCH })).toBe(false);
  });
});

describe("useWheelSmoothing", () => {
  function macWebKit(on: boolean) {
    vi.stubGlobal("navigator", {
      platform: on ? "MacIntel" : "Linux x86_64",
      vendor: "Apple Computer, Inc.",
      maxTouchPoints: 0,
    });
  }
  const mount = (timeline: HTMLElement) => {
    const scroller = { current: timeline };
    const intent = { current: 0 };
    return renderHook(() => useWheelSmoothing(scroller, intent));
  };

  it("smooths on Mac WebKit by default and follows the setting in every window", () => {
    macWebKit(true);
    const { timeline, text } = fakeTimeline();
    mount(timeline);
    expect(wheel(text, { deltaY: NOTCH })).toBe(true);
    frames.tick();
    // Another window turns it off: the glide in progress stops too.
    act(() => {
      localStorage.setItem("buzz-smooth-mouse-wheel.v1", "off");
      window.dispatchEvent(
        new StorageEvent("storage", { key: "buzz-smooth-mouse-wheel.v1" }),
      );
    });
    expect(frames.pending()).toBe(0);
    expect(wheel(text, { deltaY: NOTCH })).toBe(false);
    act(() => {
      smoothWheelPreference.set(true);
    });
    expect(wheel(text, { deltaY: NOTCH })).toBe(true);
  });

  it("adds no wheel listener elsewhere", () => {
    macWebKit(false);
    const { timeline, text } = fakeTimeline();
    const listen = vi.spyOn(timeline, "addEventListener");
    mount(timeline);
    expect(wheel(text, { deltaY: NOTCH })).toBe(false);
    expect(listen).not.toHaveBeenCalled();
  });

  it("does nothing under Reduce motion", () => {
    macWebKit(true);
    reducedMotion(true);
    const { timeline, text } = fakeTimeline();
    mount(timeline);
    expect(wheel(text, { deltaY: NOTCH })).toBe(false);
    expect(wheel(text, { deltaY: 3, deltaMode: 1 })).toBe(false);
    expect(frames.pending()).toBe(0);
  });
});

describe("the preference", () => {
  it("defaults on when storage is absent, unknown or unreadable, and saves off", () => {
    expect(smoothWheelPreference.read()).toBe(true);
    localStorage.setItem("buzz-smooth-mouse-wheel.v1", "unknown");
    expect(smoothWheelPreference.read()).toBe(true);
    expect(smoothWheelPreference.set(false)).toBeNull();
    expect(localStorage.getItem("buzz-smooth-mouse-wheel.v1")).toBe("off");
    expect(smoothWheelPreference.read()).toBe(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(smoothWheelPreference.read()).toBe(true);
  });
});
