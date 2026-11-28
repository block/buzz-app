import "./onboarding-transition.css";
import { flushSync } from "react-dom";

let navigation = 0;

/** WebKitGTK can segfault the UI process when a view transition is the first
 * thing to start accelerated compositing (#2931, WebKit bugs 321683, 323949,
 * 324730). Every Linux desktop webview is WebKitGTK, so skip on Linux and fail
 * closed rather than sniff the engine; Android reports Linux but is unaffected. */
const skipsViewTransition = () =>
  /Linux/.test(navigator.platform) && !/Android/.test(navigator.userAgent);

/** Snapshot the outgoing welcome so its bees fade away with the forward push. */
export function onboardingTransition(update: () => void, back = false) {
  if (
    !document.startViewTransition ||
    skipsViewTransition() ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  document
    .querySelector("main")
    ?.style.setProperty("view-transition-name", "onboarding");
  document.documentElement.dataset.onboardingDirection = back
    ? "back"
    : "forward";
  const current = ++navigation;
  const transition = document.startViewTransition(() => {
    flushSync(update);
    document
      .querySelector("main")
      ?.style.setProperty("view-transition-name", "onboarding");
  });
  void transition.finished
    .catch(() => {})
    .finally(() => {
      if (current !== navigation) return;
      delete document.documentElement.dataset.onboardingDirection;
      document
        .querySelector("main")
        ?.style.removeProperty("view-transition-name");
    });
}
