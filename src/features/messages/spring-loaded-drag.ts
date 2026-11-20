import { useEffect, useRef, type DragEvent } from "react";

/** How long a file drag rests on a target before it opens, as in Finder. */
export const SPRING_LOAD_DELAY_MS = 500;
/** The double blink fills the end of the delay: four phases of 75 ms, as in
 * Finder. Reduced motion skips it. */
export const SPRING_LOAD_BLINK_MS = 300;
/** A drag is known to be live for this long after its last dragover. A drag
 * that was cancelled without a leave stops producing them. */
export const SPRING_LOAD_LIVE_MS = 200;
/** A target whose delay ended with no live drag waits this long for one. */
export const SPRING_LOAD_STALE_MS = 1000;

/** Set on the hovered target: "hover" at once, then "blink" before it opens. */
export const SPRING_LOAD_ATTRIBUTE = "data-spring-loaded";
const BLINK_DURATION_PROPERTY = "--spring-loaded-blink";

type Hover = {
  owner: object;
  element: HTMLElement;
  /** The node under the drag, which tells a real leave from a child boundary. */
  under: EventTarget | null;
  open: () => void;
  /** Where and when the drag was last reported over the target. */
  x: number;
  y: number;
  seen: number;
  /** Counting down, then waiting for a live drag, then quiet once opened. */
  phase: "armed" | "due" | "quiet";
  timer: ReturnType<typeof setTimeout> | undefined;
};

// One drag hovers one target, so every target shares this state and its timer.
let hover: Hover | undefined;
// Where the drag was when a target last opened. Opening can shift the layout
// and put another target under a drag that has not moved; that one stays shut.
let sprungAt: { x: number; y: number } | undefined;

const carriesFiles = (event: DragEvent) =>
  !!event.dataTransfer?.types.includes("Files");

function paint(element: HTMLElement, state?: "hover" | "blink") {
  if (state) element.setAttribute(SPRING_LOAD_ATTRIBUTE, state);
  else element.removeAttribute(SPRING_LOAD_ATTRIBUTE);
  if (state === "blink")
    element.style.setProperty(
      BLINK_DURATION_PROPERTY,
      `${SPRING_LOAD_BLINK_MS}ms`,
    );
  else element.style.removeProperty(BLINK_DURATION_PROPERTY);
}

/** A drop, the end of the drag, or its target's unmount ends the hover. */
function cancel() {
  if (!hover) return;
  clearTimeout(hover.timer);
  paint(hover.element);
  hover = undefined;
  window.removeEventListener("drop", cancel, true);
  window.removeEventListener("dragend", cancel, true);
}

function spring(current: Hover) {
  clearTimeout(current.timer);
  current.timer = undefined;
  // The hover stays until the drag leaves, so a resting drag opens once.
  current.phase = "quiet";
  paint(current.element);
  sprungAt = { x: current.x, y: current.y };
  if (current.element.isConnected) current.open();
}

/** The delay is over. Open only under a drag that is still reporting itself. */
function due(current: Hover) {
  if (Date.now() - current.seen <= SPRING_LOAD_LIVE_MS) return spring(current);
  // No drag event says a file drag was cancelled, and a webview may skip the
  // leave. The next dragover proves the drag is live and opens the target;
  // without one the highlight is dropped.
  current.phase = "due";
  paint(current.element, "hover");
  current.timer = setTimeout(cancel, SPRING_LOAD_STALE_MS);
}

function arm(current: Hover) {
  const reducedMotion = !!window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  current.phase = "armed";
  paint(current.element, "hover");
  current.timer = setTimeout(
    () => {
      if (reducedMotion) return due(current);
      paint(current.element, "blink");
      current.timer = setTimeout(() => due(current), SPRING_LOAD_BLINK_MS);
    },
    SPRING_LOAD_DELAY_MS - (reducedMotion ? 0 : SPRING_LOAD_BLINK_MS),
  );
}

/**
 * Open a navigation target when a drag carrying files rests on it, so the drag
 * can carry on into the destination's drop zone. That is a file dragged in
 * from the OS, and also an image dragged from a message, which the webview
 * offers as a file. `active` marks the target already open. Spread the result
 * onto the element a click would activate.
 */
export function useSpringLoaded(open: () => void, active = false) {
  const owner = useRef({}).current;
  useEffect(
    () => () => {
      if (hover?.owner === owner) cancel();
    },
    [owner],
  );
  const over = (event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) return;
    const { clientX: x, clientY: y } = event;
    if (sprungAt && (sprungAt.x !== x || sprungAt.y !== y))
      sprungAt = undefined;
    if (hover?.owner !== owner || hover.element !== event.currentTarget) {
      if (sprungAt) return;
      cancel();
      hover = {
        owner,
        element: event.currentTarget,
        under: event.target,
        open,
        x,
        y,
        seen: 0,
        phase: "quiet",
        timer: undefined,
      };
      // A drop is stopped by the zone that claims it, so listen ahead of it.
      window.addEventListener("drop", cancel, true);
      window.addEventListener("dragend", cancel, true);
      if (!active) arm(hover);
    }
    Object.assign(hover, { under: event.target, open, x, y, seen: Date.now() });
    if (hover.phase === "quiet") return;
    // Without this the app rejects the drag and the cursor says so, just as
    // the target is about to open. A drop here still attaches nothing.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (hover.phase === "due") spring(hover);
  };
  return {
    onDragEnter: over,
    onDragOver: over,
    onDragLeave(event: DragEvent<HTMLElement>) {
      // Entering a child reports the child first, then this leave of its parent.
      // Leaving the target, the window or a cancelled drag reports only a leave.
      if (hover?.owner === owner && hover.under === event.target) cancel();
    },
  };
}
