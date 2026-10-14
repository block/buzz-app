import { useLayoutEffect, useRef, type RefObject } from "react";
import { readingPositioned } from "./use-reading";

/** One reveal per request signal, never per row/profile/image update. */
export function useMessageReveal({
  scroller,
  settled,
  messageId,
  signal,
  ready,
  complete,
  prepare,
  focus = true,
}: {
  scroller: RefObject<HTMLElement | null>;
  settled: RefObject<boolean>;
  messageId: string | undefined;
  signal: AbortSignal | undefined;
  ready: boolean;
  complete(): void;
  prepare?(): void;
  /** A covering modal owns focus; the underlying target still verifies/reveals. */
  focus?: boolean;
}) {
  const revealed = useRef<AbortSignal | undefined>(undefined);
  const focused = useRef<{ signal: AbortSignal; row: HTMLElement } | undefined>(
    undefined,
  );
  useLayoutEffect(() => {
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
      settled.current = false;
      // A replacement may recover lost focus, but must not take it from another
      // control after this request already focused a row successfully.
      let focusPending = false;
      if (
        focus &&
        (focused.current?.signal !== signal ||
          (focused.current.row !== row &&
            (!document.activeElement ||
              document.activeElement === document.body)))
      ) {
        row.focus({ preventScroll: true });
        focusPending = document.activeElement !== row;
        if (!focusPending) focused.current = { signal, row };
      }
      const positionedBox = row.getBoundingClientRect();
      const positionedViewport = container.getBoundingClientRect();
      const positionedWindowHeight = window.innerHeight;
      frame = requestAnimationFrame(() => {
        if (signal?.aborted || !row.isConnected || !container.contains(row))
          return;
        const box = row.getBoundingClientRect();
        const viewport = container.getBoundingClientRect();
        const viewportTop = Math.max(viewport.top, 0);
        const viewportBottom = Math.min(viewport.bottom, window.innerHeight);
        // A divider alone can intersect before the message is readable. Rows
        // that fit need full height; taller rows need the available viewport.
        const visible =
          viewportBottom > viewportTop &&
          box.height > 0 &&
          box.width > 0 &&
          Math.min(box.bottom, viewportBottom) -
            Math.max(box.top, viewportTop) >=
            Math.min(box.height, viewportBottom - viewportTop) &&
          box.right > Math.max(viewport.left, 0) &&
          box.left < Math.min(viewport.right, window.innerWidth);
        if (focus && (focusPending || row.closest("[inert]"))) return;
        if (!visible) {
          // A late correction can follow native positioning without a DOM
          // mutation. Reposition on measured progress, never retry a stuck row.
          if (
            box.top !== positionedBox.top ||
            box.bottom !== positionedBox.bottom ||
            viewport.top !== positionedViewport.top ||
            viewport.bottom !== positionedViewport.bottom ||
            window.innerHeight !== positionedWindowHeight
          )
            schedule();
          return;
        }
        settled.current = true;
        revealed.current = signal;
        cancel();
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
  }, [scroller, settled, messageId, signal, ready, complete, prepare, focus]);
  return revealed;
}
