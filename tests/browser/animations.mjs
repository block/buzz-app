// Waits until no finite animation is running on the target element or, with
// `subtree`, on its descendants. Motion cancels an animation it replaces, and
// a cancelled animation's `finished` promise rejects with AbortError, so
// awaiting every `finished` with Promise.all fails on such an interruption.
// The replacement keeps running, so the wait also covers animations that start
// while it runs. Infinite animations, such as spinners, never finish and are
// ignored. If animations are still running after 10 s, for example because
// something keeps starting them, the wait fails and names each one, instead of
// holding until the test's timeout. `target` is a Locator or an element handle.
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
    // A CSS animation or transition has a name; Motion's animations are
    // named by the properties they animate.
    const timing = new Set(["offset", "computedOffset", "easing", "composite"]);
    const describe = ({ animationName, transitionProperty, effect }) => {
      const properties = new Set(effect.getKeyframes().flatMap(Object.keys));
      const name =
        animationName ??
        transitionProperty ??
        [...properties.difference(timing)].join(", ");
      const pseudo = effect.pseudoElement ? `${effect.pseudoElement} of ` : "";
      return `${name} on ${pseudo}${effect.target.cloneNode(false).outerHTML}`;
    };
    const deadline = performance.now() + 10_000;
    while (true) {
      const animations = running();
      if (!animations.length) return;
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new Error(
          `Animations still running after 10 s: ${animations.map(describe).join("; ")}`,
        );
      await Promise.race([
        Promise.allSettled(animations.map((animation) => animation.finished)),
        new Promise((resolve) => setTimeout(resolve, remaining)),
      ]);
    }
  }, subtree);
}
