import { useLayoutEffect, type RefObject } from "react";
import { macWebKit } from "./mac-webkit";
import { smoothWheelPreference } from "./smooth-wheel-preference";

// Mac WebKit applies each mouse-wheel notch as one instant jump; Chromium
// animates it. With Smooth mouse-wheel scrolling on, the channel timeline and
// thread panels glide each notch instead and leave trackpad input to WebKit.
//
// Mouse vs trackpad: WebKit on macOS reports a mouse notch as a 16.16
// fixed-point line count times 40px, so its deltaY is fractional
// (4.000244140625 is 6554/65536 x 40). Trackpad deltas are whole pixels.
// Line and page delta modes are always a wheel. A gesture's first event
// decides for the whole gesture, so one device never alternates between
// gliding and native scrolling mid-gesture.

export const LINE_PX = 40;
/** One notch's glide. Bigger moves take less, down to half, as in Chromium. */
export const NOTCH_MS = 190;
/** Longer than any pause inside one gesture: trackpad scrolling and its
 * momentum send an event every frame, a spinning wheel about as often. */
export const GESTURE_GAP_MS = 200;

type WheelInput = Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY">;

export function isMouseWheel(event: WheelInput) {
  if (event.deltaMode !== 0) return true;
  return !Number.isInteger(event.deltaY) || !Number.isInteger(event.deltaX);
}

export function toPixels(event: WheelInput, element: Element) {
  if (event.deltaMode === 1) return event.deltaY * LINE_PX;
  if (event.deltaMode === 2) return event.deltaY * element.clientHeight;
  return event.deltaY;
}

/** A dialog or open popover rendered within message DOM (an expanded
 * equation, a hover card) is outside the scroller's native scroll chain. */
function insideOverlay(target: Element) {
  if (target.closest('dialog, [role="dialog"], [aria-modal="true"]'))
    return true;
  for (
    let node = target.closest("[popover]");
    node;
    node = node.parentElement?.closest("[popover]") ?? null
  )
    if (node.matches(":popover-open")) return true;
  return false;
}

/** A scrollable element between the target and the scroller scrolls itself. */
function insideNestedScroller(target: Element, scroller: Element) {
  for (
    let node: Element | null = target;
    node && node !== scroller;
    node = node.parentElement
  ) {
    if (node.scrollHeight <= node.clientHeight + 1) continue;
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return true;
  }
  return false;
}

/** How long a glide of `distance` pixels takes: Chromium's wheel durations. */
export const glideDuration = (distance: number) =>
  (NOTCH_MS * Math.min(12, Math.max(6, 14 - Math.abs(distance) / 60))) / 12;

/** The glide's ease, cubic-bezier(0.53, y1, 0.38, 0.65), from 0 to 1 over
 * progress 0 to 1. A higher `y1` starts it faster. */
function ease(y1: number) {
  const curve = (a: number, b: number) => (t: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  const x = curve(0.53, 0.38);
  const y = curve(y1, 0.65);
  return (progress: number) => {
    if (!(progress > 0)) return 0;
    if (progress >= 1) return 1;
    // x rises monotonically from 0 to 1, so bisection finds its t.
    let low = 0;
    let high = 1;
    for (let i = 0; i < 30; i++) {
      const t = (low + high) / 2;
      if (x(t) < progress) low = t;
      else high = t;
    }
    return y((low + high) / 2);
  };
}
const EASE_Y1 = 0.21;
const EASE_X1 = 0.53;
/** A new glide's first frame counts as one frame in, so it moves at once. */
const FRAME_MS = 16;

type Glide = {
  /** The segment being eased, from `from` to `to` in scroll positions. */
  from: number;
  to: number;
  /** The frame time it began, set by the first frame of a new glide. */
  start: number | undefined;
  duration: number;
  ease: (progress: number) => number;
  /** Where the glide has got to, as a float so sub-pixel steps add up. */
  position: number;
  /** The scrollTop read back after the last write, to spot corrections. */
  written: number;
  /** The last frame's time. */
  last: number | undefined;
  /** How far the glide moved in the last millisecond before that frame. */
  speed: number;
  frame: number;
  /** The scroller's reader intent once this glide's latest notch was handled. */
  intent: number | undefined;
};

function positionAt(glide: Glide, time: number) {
  if (glide.start === undefined) return glide.from;
  const progress = (time - glide.start) / glide.duration;
  return glide.from + (glide.to - glide.from) * glide.ease(progress);
}

/** Eases from where the last frame left the glide to its new `to`, starting
 * at the glide's speed then, so a run of notches never slows between them. */
function retarget(glide: Glide, to: number) {
  const now = glide.last;
  const speed = glide.speed;
  const from = glide.position;
  const distance = to - from;
  const duration = glideDuration(distance);
  // The curve's starting slope is y1 / x1 times the segment's average speed.
  // With y1 at most 1 it never passes `to`, so a fast glide gaining a small
  // notch starts a little slower instead of overshooting and coming back.
  const ratio = distance
    ? Math.min(20, Math.max(0, (speed * duration) / distance))
    : 0;
  glide.ease = ease(Math.max(EASE_Y1, Math.min(1, ratio * EASE_X1)));
  glide.from = from;
  glide.to = to;
  glide.duration = duration;
  glide.start = now;
}

const targets = new WeakMap<Element, () => number | undefined>();

/** Where a glide in progress over `scroller` will come to rest, which is where
 * a native notch would already be; undefined when nothing is gliding. */
export function glideTarget(scroller: Element) {
  return targets.get(scroller)?.();
}

/**
 * Glides mouse-wheel notches over `scroller` until the returned cleanup.
 * Glide writes are not reader intent: the wheel still reaches the scroller's
 * own handlers, which release bottom follow, load older history and retire
 * held anchors and retained navigation. Any newer `intent()` than the glide's
 * own notches (other reader input, a send, Jump to latest or a reveal) ends it.
 */
export function smoothWheel(scroller: HTMLElement, intent: () => number) {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let glide: Glide | undefined;
  /** The accepted notch still on its way to the scroller's own handlers. */
  let notch: Event | undefined;
  const stop = () => {
    if (glide) cancelAnimationFrame(glide.frame);
    glide = undefined;
  };
  /** Newer reader intent than the glide's notches retires its motion. A notch
   * whose propagation was stopped never reached `handled`; adopt it now. */
  const superseded = (current: Glide) => {
    current.intent ??= intent();
    return current.intent !== intent();
  };
  /** The current gesture's device, decided by its first event. */
  let gesture: { mouse: boolean; last: number } | undefined;
  const fromMouse = (event: WheelEvent) => {
    if (!gesture || event.timeStamp - gesture.last >= GESTURE_GAP_MS)
      gesture = { mouse: isMouseWheel(event), last: event.timeStamp };
    gesture.last = event.timeStamp;
    return gesture.mouse;
  };
  const step = (now: number) => {
    const current = glide;
    if (!current) return;
    if (superseded(current)) {
      glide = undefined;
      return;
    }
    if (reducedMotion?.matches) {
      // The notches still arrive, just without the motion.
      scroller.scrollTop += current.to - current.position;
      glide = undefined;
      return;
    }
    // Carry the scroller's own corrections (Virtua's and scroll-correction.ts
    // in the timeline, reading corrections in a thread) instead of undoing them.
    const drift = scroller.scrollTop - current.written;
    if (Math.abs(drift) >= 1) {
      current.position += drift;
      current.from += drift;
      current.to += drift;
    }
    current.start ??= now - FRAME_MS;
    current.last = now;
    const progress = (now - current.start) / current.duration;
    current.position = positionAt(current, now);
    // Measured here, so a second notch in the same frame keeps it too.
    current.speed = current.position - positionAt(current, now - 1);
    scroller.scrollTop = current.position;
    current.written = scroller.scrollTop;
    if (progress >= 1) {
      glide = undefined;
      return;
    }
    current.frame = requestAnimationFrame(step);
  };
  /** Glides `event` when it is a mouse notch the scroller can move for. */
  const take = (event: WheelEvent) => {
    const mouse = fromMouse(event);
    // Under Reduce motion a wheel goes native, and its reader intent would
    // retire the glide before its next frame lands the rest of the notch.
    if (reducedMotion?.matches && glide) {
      if (!superseded(glide)) scroller.scrollTop += glide.to - glide.position;
      stop();
    }
    if (
      !event.cancelable ||
      !mouse ||
      reducedMotion?.matches ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      !event.deltaY ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
    )
      return false;
    const delta = toPixels(event, scroller);
    const top = scroller.scrollTop;
    const max = scroller.scrollHeight - scroller.clientHeight;
    // At an edge, the wheel keeps its native behavior.
    if (delta < 0 ? top <= 0 : top >= max - 1) return false;
    event.preventDefault();
    if (
      glide &&
      (Math.sign(delta) !== Math.sign(glide.to - glide.position) ||
        superseded(glide))
    )
      stop();
    // The notch lands within the scroll range, easing into an edge.
    const to = Math.max(0, Math.min(max, (glide?.to ?? top) + delta));
    if (glide) retarget(glide, to);
    else
      glide = {
        from: top,
        to,
        start: undefined,
        duration: glideDuration(to - top),
        ease: ease(EASE_Y1),
        position: top,
        written: top,
        last: undefined,
        speed: 0,
        frame: requestAnimationFrame(step),
        intent: undefined,
      };
    glide.intent = undefined;
    notch = event;
    return true;
  };
  /** After the app root's handlers, a notch has raised all its own intent. */
  const handled = (event: Event) => {
    if (event !== notch) return;
    notch = undefined;
    if (glide) glide.intent = intent();
  };
  const wheel = (event: WheelEvent) => {
    if (
      event.defaultPrevented ||
      !(event.target instanceof Element) ||
      insideOverlay(event.target) ||
      insideNestedScroller(event.target, scroller)
    )
      return;
    take(event);
  };
  // Not once newer intent (Jump to latest, a send) has ended the glide.
  const target = () =>
    glide && (glide.intent === undefined || glide.intent === intent())
      ? glide.to
      : undefined;
  targets.set(scroller, target);
  scroller.addEventListener("wheel", wheel, { passive: false });
  scroller.ownerDocument.addEventListener("wheel", handled, { passive: true });
  return () => {
    scroller.removeEventListener("wheel", wheel);
    scroller.ownerDocument.removeEventListener("wheel", handled);
    if (targets.get(scroller) === target) targets.delete(scroller);
    stop();
  };
}

/** Smooths mouse wheels over `scroller` on Mac WebKit while the setting is on.
 * Off, no wheel listener blocks WebKit's threaded scrolling. */
export function useWheelSmoothing(
  scroller: RefObject<HTMLElement | null>,
  intent: RefObject<number>,
) {
  const enabled = smoothWheelPreference.usePreference();
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!enabled || !element || !macWebKit()) return;
    return smoothWheel(element, () => intent.current);
  }, [enabled, scroller, intent]);
}
