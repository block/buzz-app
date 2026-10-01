/** One owner for pausing finite relay requests while this document may unload.
 * Requests keep their existing deadlines during navigation. beforeunload is
 * reversible, so pause admission rather than disposing the session. Fetch
 * rejection recovery (even a timer/MessageChannel) can run before pagehide.
 * Resume only when this document renders again or is shown (e.g. cancelled
 * navigation or BFCache restoration), not from a fetch-recovery task. A render
 * is not proof navigation was cancelled: some browsers render while waiting
 * for the destination. This gates finite requests, not the separate live stream. */
export function createNavigationPause(onResume: () => void = () => {}) {
  const page = typeof window === "undefined" ? undefined : window;
  let suspended = false;
  let frame: number | undefined;
  const waiters = new Set<() => void>();
  const release = () => {
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  const cancelResume = () => {
    if (frame !== undefined) page?.cancelAnimationFrame(frame);
    frame = undefined;
  };
  const resume = () => {
    cancelResume();
    suspended = false;
    release();
    onResume();
  };
  const hidden = () => {
    suspended = true;
    cancelResume();
  };
  const leaving = () => {
    hidden();
    frame = page?.requestAnimationFrame(resume);
  };
  page?.addEventListener("beforeunload", leaving);
  page?.addEventListener("pagehide", hidden);
  page?.addEventListener("pageshow", resume);
  return {
    paused: () => suspended,
    /** Settles on resume, or on disposal so owners can observe their own closure. */
    resumed: () =>
      suspended
        ? new Promise<void>((resolve) => waiters.add(resolve))
        : Promise.resolve(),
    dispose() {
      cancelResume();
      page?.removeEventListener("beforeunload", leaving);
      page?.removeEventListener("pagehide", hidden);
      page?.removeEventListener("pageshow", resume);
      release();
    },
  };
}
