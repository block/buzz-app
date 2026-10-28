/** Frames can stop after a change is scheduled; it is never held longer. */
export const frameDeadlineMs = 100;

/**
 * Renders a store's changes at the start of the next frame, once for any
 * number of changes before it. A live row then commits before that frame's
 * layout, so lists measure it before a follow scroll, which runs a frame
 * later. Committed from the socket task instead, a row was still unmeasured
 * when the timeline's follow scroll ran; Virtua took the corrected scroll for
 * a reader gesture and remounted the rows behind it when it went idle.
 */
export function subscribeInFrames(
  subscribe: (listener: () => void) => () => void,
) {
  return (listener: () => void) => {
    let frame: number | undefined;
    let late: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(late);
      frame = late = undefined;
    };
    const deliver = () => {
      cancel();
      listener();
    };
    const release = subscribe(() => {
      // Hidden documents run no frames.
      if (document.visibilityState === "hidden") deliver();
      else if (frame === undefined) {
        frame = requestAnimationFrame(deliver);
        late = setTimeout(deliver, frameDeadlineMs);
      }
    });
    return () => {
      cancel();
      release();
    };
  };
}
