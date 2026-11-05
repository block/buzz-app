import { useLayoutEffect, useRef, type RefObject } from "react";
import { highlightWhenSettled, onScreen } from "./message-highlight";
import { readingPositioned } from "./use-reading";

// Presses and clicks, counted from the first request. An opening may move
// focus itself; a move the person makes while the target loads is theirs.
let inputs = 0;
let counting = false;
const countInput = () => {
  inputs++;
};
const requests = new WeakMap<
  AbortSignal,
  { focus: Element | null; inputs: number }
>();

/** Records where focus was when a reveal request began. Owners that wait
 * before passing a request on call this when they first receive it. */
export function beginReveal(signal: AbortSignal) {
  if (!counting) {
    counting = true;
    document.addEventListener("pointerdown", countInput, true);
    document.addEventListener("keydown", countInput, true);
  }
  if (!requests.has(signal))
    requests.set(signal, { focus: document.activeElement, inputs });
}

/** One reveal per request signal, never per row/profile/image update. */
export function useMessageReveal({
  scroller,
  settled,
  messageId,
  signal,
  ready,
  complete,
  prepare,
  placed,
  hold,
  focus = true,
  mark = focus,
}: {
  scroller: RefObject<HTMLElement | null>;
  settled: RefObject<boolean>;
  messageId: string | undefined;
  signal: AbortSignal | undefined;
  ready: boolean;
  complete(): void;
  prepare?(): void;
  /** Align a virtualizer's retained request with the exact native placement. */
  placed?(): void;
  /** A covering modal owns focus; the underlying target still verifies/reveals. */
  focus?: boolean;
  /** Whether the reader sees this arrival; a reveal beside the reader that
   * owns focus is marked too. Defaults to `focus`. */
  mark?: boolean;
  /**
   * While this returns true after the reveal, keep the row where the reveal put
   * it. Rows mounted around the target can measure after verification and push
   * it out of view. The owner ends the hold on reader intent.
   */
  hold?: () => boolean;
}) {
  const revealed = useRef<AbortSignal | undefined>(undefined);
  const focused = useRef<{ signal: AbortSignal; row: HTMLElement } | undefined>(
    undefined,
  );
  // Outlives the reveal effect: a dependency change after completion must not
  // end the hold, but unmount and the next reveal do.
  const holding = useRef<(() => void) | undefined>(undefined);
  // Every arrival is marked the same way, whatever sent the reader here.
  const highlight = useRef<() => void>(() => {});
  useLayoutEffect(
    () => () => {
      holding.current?.();
      highlight.current();
    },
    [],
  );
  useLayoutEffect(() => {
    if (signal && !signal.aborted) beginReveal(signal);
    if (
      !ready ||
      !messageId ||
      !signal ||
      signal.aborted ||
      revealed.current === signal
    )
      return;
    const container = scroller.current;
    if (!container) return;
    const target = messageId;
    let frame = 0;
    const cancel = () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      inertObserver.disconnect();
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reveal);
    };
    const observer = new MutationObserver(schedule);
    const inertObserver = new MutationObserver(schedule);
    function reveal() {
      if (!signal || signal.aborted || !container?.isConnected) return;
      const row = [
        ...container.querySelectorAll<HTMLElement>("[data-message-id]"),
      ].find((element) => element.dataset.messageId === messageId);
      if (!row) return; // Virtual rows mount asynchronously; observe the real mount.
      row.tabIndex = -1;
      row.scrollIntoView({
        block: "start",
        inline: "nearest",
        behavior: "instant",
      });
      placed?.();
      settled.current = true;
      // A replacement may recover lost focus, but must not take it from another
      // control after this request already focused a row successfully. Nor
      // does the first reveal take focus the person moved since the request.
      const start = requests.get(signal);
      const active = document.activeElement;
      const moved =
        !!start &&
        inputs > start.inputs &&
        !!active &&
        active !== document.body &&
        active !== start.focus;
      let focusPending = false;
      if (
        focus &&
        !moved &&
        (focused.current?.signal !== signal ||
          (focused.current.row !== row &&
            (!document.activeElement ||
              document.activeElement === document.body)))
      ) {
        row.focus({ preventScroll: true });
        focusPending = document.activeElement !== row;
        if (!focusPending) focused.current = { signal, row };
      }
      const position = {
        top:
          row.getBoundingClientRect().top -
          container.getBoundingClientRect().top,
        width: container.clientWidth,
        height: container.clientHeight,
      };
      frame = requestAnimationFrame(() => {
        if (signal?.aborted || !row.isConnected || !container.contains(row))
          return;
        // Neither focus nor the arrival cue reaches a row behind a cover.
        if (
          (focus && focusPending) ||
          ((focus || mark) && row.closest("[inert]"))
        )
          return;
        holding.current?.();
        holding.current = hold
          ? keep(container, target, signal, hold, position)
          : undefined;
        if (
          !onScreen(
            row.getBoundingClientRect(),
            container.getBoundingClientRect(),
          )
        ) {
          holding.current?.();
          holding.current = undefined;
          return;
        }
        revealed.current = signal;
        cancel();
        highlight.current();
        // A reveal behind a covering panel is not an arrival the reader sees.
        if (mark) highlight.current = highlightWhenSettled(container, target);
        readingPositioned(container);
        complete();
      });
    }
    signal.addEventListener("abort", cancel, { once: true });
    // Virtua attaches its scroller in an effect, after our layout effect.
    frame = requestAnimationFrame(() => {
      observer.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style"],
      });
      const inertAncestor = container.closest("[inert]");
      if (inertAncestor)
        inertObserver.observe(inertAncestor, {
          attributes: true,
          attributeFilter: ["inert"],
        });
      prepare?.();
      schedule();
    });
    return () => {
      cancel();
      signal.removeEventListener("abort", cancel);
    };
  }, [
    scroller,
    settled,
    messageId,
    signal,
    ready,
    complete,
    prepare,
    placed,
    focus,
    mark,
    hold,
  ]);
  return revealed;
}

/** Undo layout drift of a revealed row until its owner, request or viewport ends the hold. */
function keep(
  container: HTMLElement,
  messageId: string,
  signal: AbortSignal,
  hold: () => boolean,
  { top: at, width, height }: { top: number; width: number; height: number },
) {
  const offset = () => {
    const row = [
      ...container.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find((element) => element.dataset.messageId === messageId);
    return row
      ? row.getBoundingClientRect().top - container.getBoundingClientRect().top
      : undefined;
  };
  let frame = 0;
  const release = () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    signal.removeEventListener("abort", release);
  };
  const check = () => {
    const now = offset();
    // A resized viewport is a new layout, not drift; the owner positions it.
    if (
      signal.aborted ||
      !hold() ||
      !container.isConnected ||
      container.clientWidth !== width ||
      container.clientHeight !== height ||
      now === undefined
    )
      return release();
    if (Math.abs(now - at) >= 0.5) container.scrollTop += now - at;
  };
  const observer = new MutationObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(check);
  });
  observer.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style"],
  });
  signal.addEventListener("abort", release, { once: true });
  check();
  return release;
}
