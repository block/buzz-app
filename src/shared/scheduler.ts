import {
  startTransition,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

// Main-thread priority lanes. Input runs first (React's discrete events), and
// background store updates render as interruptible transitions with a deadline.

const discrete = new Set([
  "keydown",
  "keyup",
  "keypress",
  "beforeinput",
  "input",
  "compositionend",
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "touchstart",
  "touchend",
  "paste",
  "cut",
  "drop",
  "focusin",
  "focusout",
  "submit",
]);

/** True while the host is dispatching a user input event. */
export function handlingInput(): boolean {
  if (typeof window === "undefined") return false;
  const event = window.event;
  return !!event && discrete.has(event.type);
}

/** Longest a background update may wait behind input before it renders anyway. */
export const backgroundBudgetMs = 50;

const overdue = new Set<() => void>();
let deadline: ReturnType<typeof setTimeout> | undefined;
let since = 0;
// A saturated main thread runs the deadline timer late, so input that arrives
// after the budget renders overdue updates with itself.
const inputs = ["keydown", "pointerdown"] as const;

function flushOverdue() {
  settle();
  const updates = [...overdue];
  overdue.clear();
  // One task, so React commits every forced subscriber together.
  for (const update of updates) update();
}

function flushOnInput() {
  if (performance.now() - since >= backgroundBudgetMs) flushOverdue();
}

function settle() {
  clearTimeout(deadline);
  deadline = undefined;
  for (const type of inputs)
    window.removeEventListener(type, flushOnInput, true);
}

/**
 * Renders `update` (a React state update) as a transition so input preempts
 * it, unless it is already handling input. If the transition has not
 * committed within the budget, `urgent` renders it with every other overdue
 * update, at the deadline or with the next input, whichever runs first. Call
 * the returned function once the update has committed.
 */
export function scheduleBackgroundUpdate(
  update: () => void,
  urgent = update,
): () => void {
  if (handlingInput()) {
    urgent();
    return () => {};
  }
  startTransition(update);
  overdue.add(urgent);
  if (deadline === undefined) {
    since = performance.now();
    deadline = setTimeout(flushOverdue, backgroundBudgetMs);
    for (const type of inputs)
      window.addEventListener(type, flushOnInput, true);
  }
  return () => {
    overdue.delete(urgent);
    if (!overdue.size) settle();
  };
}

const always = () => true;

/**
 * useSyncExternalStore, except that changes published outside user input
 * render as a transition, so keystrokes preempt them for at most the budget.
 * Changes caused by input, and changes `background` rejects (a requested
 * page, a status change), stay urgent.
 */
export function useBackgroundStore<T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
  background: (current: T, next: T) => boolean = always,
): T {
  // The snapshot shown urgently for this source. A background change reaches
  // it only once its transition commits (or is forced).
  const shown = useMemo(
    () => ({ value: getSnapshot(), version: 0, seq: 0 }),
    [getSnapshot],
  );
  const [transition, setTransition] = useState<{
    shown: typeof shown;
    value: T;
    version: number;
  }>();
  const pending = useRef<() => void>(undefined);
  const subscribeShown = useCallback(
    (notify: () => void) => {
      const publish = () => {
        shown.value = getSnapshot();
        shown.version = ++shown.seq;
        notify();
      };
      const render = () => {
        const version = ++shown.seq;
        setTransition(() => ({ shown, value: getSnapshot(), version }));
      };
      const listener = () => {
        const next = getSnapshot();
        if (Object.is(shown.value, next)) return;
        pending.current?.();
        pending.current = undefined;
        if (!handlingInput() && background(shown.value, next))
          pending.current = scheduleBackgroundUpdate(render, publish);
        else publish();
      };
      const unsubscribe = subscribe(listener);
      // Publishes between render and subscription.
      listener();
      return () => {
        unsubscribe();
        pending.current?.();
        pending.current = undefined;
      };
    },
    [subscribe, getSnapshot, background, shown],
  );
  const getShown = useCallback(() => shown.value, [shown]);
  const urgent = useSyncExternalStore(subscribeShown, getShown, getShown);
  const fresh =
    transition?.shown === shown && transition.version > shown.version;
  useLayoutEffect(() => {
    if (!fresh) return;
    shown.value = transition.value;
    shown.version = transition.version;
    pending.current?.();
    pending.current = undefined;
  });
  return fresh ? transition.value : urgent;
}
