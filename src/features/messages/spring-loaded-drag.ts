import { useEffect, useRef, type DragEvent } from "react";

/** How long a file drag rests on a target before it opens, as in Finder. */
export const SPRING_LOAD_DELAY_MS = 500;
/** The double blink fills the end of the delay. Reduced motion skips it. */
export const SPRING_LOAD_BLINK_MS = 200;

/** Set on the hovered target: "hover" at once, then "blink" before it opens. */
export const SPRING_LOAD_ATTRIBUTE = "data-spring-loaded";
const BLINK_DURATION_PROPERTY = "--spring-loaded-blink";

type Hover = {
  owner: object;
  element: HTMLElement;
  /** The node under the drag, which tells a real leave from a child boundary. */
  under: EventTarget | null;
  open: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

// One drag hovers one target, so every target shares this state and its timer.
let hover: Hover | undefined;

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
  current.timer = undefined;
  paint(current.element);
  // The hover stays until the drag leaves, so a resting drag opens once.
  if (current.element.isConnected) current.open();
}

function arm(current: Hover) {
  const reducedMotion = !!window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  paint(current.element, "hover");
  current.timer = setTimeout(
    () => {
      if (reducedMotion) return spring(current);
      paint(current.element, "blink");
      current.timer = setTimeout(() => spring(current), SPRING_LOAD_BLINK_MS);
    },
    SPRING_LOAD_DELAY_MS - (reducedMotion ? 0 : SPRING_LOAD_BLINK_MS),
  );
}

/**
 * Open a navigation target when a file drag rests on it, so the drag can carry
 * on into the destination's drop zone. `active` marks the target already open.
 * Spread the result onto the element a click would activate.
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
    if (hover?.owner === owner && hover.element === event.currentTarget) {
      hover.under = event.target;
      hover.open = open;
      return;
    }
    cancel();
    hover = {
      owner,
      element: event.currentTarget,
      under: event.target,
      open,
      timer: undefined,
    };
    // A drop is stopped by the zone that claims it, so listen ahead of it.
    window.addEventListener("drop", cancel, true);
    window.addEventListener("dragend", cancel, true);
    if (!active) arm(hover);
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
