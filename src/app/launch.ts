// Matches the repeated SMIL tracks in public/buzz-loading-mark.svg.
const CYCLE_MS = 1760;
const FADE_MS = 220;
// A saved workspace stays usable if its live refresh stalls.
const SETTLING_BUDGET_MS = CYCLE_MS * 2;

let ready = false;
let leaving = false;
let timer: number | undefined;
let budgetTimer: number | undefined;
let waitingForMark = false;
let observer: MutationObserver | undefined;
let contentReady = false;
let bypassPending = false;
let revision = 0;
const fallbackStartedAt = performance.now();

function revealRoot() {
  const root = document.getElementById("root");
  root?.removeAttribute("inert");
  root?.removeAttribute("aria-hidden");
}

function startedAt() {
  const value = Number(
    document.getElementById("buzz-launch")?.dataset.startedAt,
  );
  return Number.isFinite(value) ? value : fallbackStartedAt;
}

function hasPendingContent() {
  if (bypassPending) return false;
  if (document.querySelector('#root [data-buzz-launch-pending="required"]'))
    return true;
  return (
    !!document.querySelector('#root [data-buzz-launch-pending="settling"]') &&
    performance.now() < startedAt() + SETTLING_BUDGET_MS
  );
}

function checkSettlingBudget() {
  budgetTimer = undefined;
  const remaining = startedAt() + SETTLING_BUDGET_MS - performance.now();
  if (remaining > 0)
    budgetTimer = window.setTimeout(checkSettlingBudget, remaining);
  else syncContent();
}

function watchContent() {
  if (observer || !document.getElementById("buzz-launch")) return;
  const root = document.getElementById("root");
  if (!root) return;
  budgetTimer = window.setTimeout(
    checkSettlingBudget,
    Math.max(0, startedAt() + SETTLING_BUDGET_MS - performance.now()),
  );
  observer = new MutationObserver(syncContent);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-buzz-launch-pending"],
  });
}

function fade(launch: HTMLElement) {
  if (leaving || !ready || !launch.isConnected) return;
  if (hasPendingContent()) {
    syncContent();
    return;
  }
  leaving = true;
  if (budgetTimer !== undefined) window.clearTimeout(budgetTimer);
  observer?.disconnect();
  observer = undefined;
  launch.classList.add("buzz-launch--leaving");
  window.setTimeout(() => {
    launch.remove();
    revealRoot();
  }, FADE_MS + 20);
}

function schedule() {
  const launch = document.getElementById("buzz-launch");
  if (!launch || !ready || !contentReady || leaving) return;
  if (timer !== undefined) window.clearTimeout(timer);

  const mark = launch.querySelector("img");
  if (mark && !mark.complete) {
    if (!waitingForMark) {
      waitingForMark = true;
      mark.addEventListener("load", schedule, { once: true });
      mark.addEventListener("error", schedule, { once: true });
    }
    return;
  }
  if (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    launch.dataset.failed === "true" ||
    !mark?.naturalWidth
  ) {
    fade(launch);
    return;
  }

  const startedAt = Number(launch.dataset.startedAt ?? performance.now());
  const now = performance.now();
  const cycles = Math.max(1, Math.ceil((now - startedAt) / CYCLE_MS));
  const deadline = startedAt + cycles * CYCLE_MS;
  timer = window.setTimeout(
    () => {
      timer = undefined;
      // A backgrounded tab can wake well past the boundary. Let that cycle finish.
      if (performance.now() - deadline > 50) schedule();
      else fade(launch);
    },
    Math.max(0, deadline - now),
  );
}

function syncContent() {
  const next = ready && !hasPendingContent();
  if (next === contentReady) return;
  contentReady = next;
  const current = ++revision;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  if (!next) return;
  // Let the first history rows, virtualizer measurements, and fonts paint
  // underneath the overlay before choosing the animation boundary.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void (document.fonts?.ready ?? Promise.resolve()).then(() => {
        if (current === revision && ready && !hasPendingContent()) schedule();
        else syncContent();
      });
    }),
  );
}

export function setLaunchReady(next: boolean, terminal = false) {
  ready = next;
  bypassPending = terminal;
  if (!document.getElementById("buzz-launch")) revealRoot();
  watchContent();
  syncContent();
}
