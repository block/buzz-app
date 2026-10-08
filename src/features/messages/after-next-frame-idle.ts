/** Without requestIdleCallback (WebKit), how long the caller must stay quiet
 * before idle work runs. A task right after the next frame is no idle
 * period: a channel switch's work would land in the frame after its first
 * visible one. */
export const QUIET_MS = 100;

/** Runs `run` in the first idle period after the next frame, so work
 * scheduled from a frame lands after the one that follows, and in each later
 * idle period until it returns true. Without requestIdleCallback, once
 * `QUIET_MS` pass after that frame with no `quiet()` call (the caller reports
 * its own activity: new rows, scrolls), then in the following tasks: work
 * that has started may scroll by itself, so only `cancel()` stops it. */
export function afterNextFrameIdle(run: () => boolean) {
  let cancel = () => {};
  let quiet = () => {};
  const frame = requestAnimationFrame(() => {
    if (typeof requestIdleCallback === "function") {
      const slice = () => {
        if (!run()) id = requestIdleCallback(slice);
      };
      let id = requestIdleCallback(slice);
      cancel = () => cancelIdleCallback(id);
      return;
    }
    let task: ReturnType<typeof setTimeout> | undefined;
    const slice = () => {
      quiet = () => {};
      if (!run()) task = setTimeout(slice);
    };
    quiet = () => {
      clearTimeout(task);
      task = setTimeout(slice, QUIET_MS);
    };
    cancel = () => clearTimeout(task);
    quiet();
  });
  return {
    cancel() {
      cancelAnimationFrame(frame);
      cancel();
      quiet = () => {};
    },
    quiet: () => quiet(),
  };
}
