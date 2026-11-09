// Waits until no finite animation is running on the target element or, with
// `subtree`, on its descendants. Motion cancels an animation it replaces, and
// a cancelled animation's `finished` promise rejects with AbortError, so
// awaiting every `finished` with Promise.all fails on such an interruption.
// The replacement keeps running, so the wait also covers animations that start
// while it runs. Infinite animations, such as spinners, never finish and are
// ignored. `target` is a Locator or an element handle.
export async function animationsSettled(target, { subtree = false } = {}) {
  await target.evaluate(async (element, subtree) => {
    const running = () =>
      element
        .getAnimations({ subtree })
        .filter(
          (animation) =>
            animation.playState === "running" &&
            animation.effect?.getComputedTiming().endTime !== Infinity,
        );
    while (running().length)
      await Promise.allSettled(
        running().map((animation) => animation.finished),
      );
  }, subtree);
}
