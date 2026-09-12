import { useLayoutEffect, useRef, type RefObject } from "react";

/** One reveal per request signal, never per row/profile/image update. */
export function useMessageReveal({
  scroller,
  settled,
  messageId,
  signal,
  ready,
  complete,
}: {
  scroller: RefObject<HTMLElement | null>;
  settled: RefObject<boolean>;
  messageId: string;
  signal: AbortSignal;
  ready: boolean;
  complete(): void;
}) {
  const revealed = useRef<AbortSignal | undefined>(undefined);
  useLayoutEffect(() => {
    if (!ready || signal.aborted || revealed.current === signal) return;
    const container = scroller.current;
    if (!container) return;
    let frame = 0;
    const cancel = () => cancelAnimationFrame(frame);
    signal.addEventListener("abort", cancel, { once: true });
    frame = requestAnimationFrame(() => {
      if (signal.aborted || !container.isConnected) return;
      const row = [
        ...container.querySelectorAll<HTMLElement>("[data-message-id]"),
      ].find((element) => element.dataset.messageId === messageId);
      if (!row) return;
      row.tabIndex = -1;
      row.scrollIntoView({
        block: "start",
        inline: "nearest",
        behavior: "instant",
      });
      // Position is settled before focus schedules the ordinary dwell lease.
      settled.current = true;
      row.focus({ preventScroll: true });
      frame = requestAnimationFrame(() => {
        if (signal.aborted || !row.isConnected || !container.contains(row))
          return;
        const box = row.getBoundingClientRect();
        const viewport = container.getBoundingClientRect();
        const visible =
          box.height > 0 &&
          box.width > 0 &&
          box.bottom > Math.max(viewport.top, 0) &&
          box.top < Math.min(viewport.bottom, window.innerHeight) &&
          box.right > Math.max(viewport.left, 0) &&
          box.left < Math.min(viewport.right, window.innerWidth);
        if (document.activeElement !== row || !visible) return;
        revealed.current = signal;
        complete();
      });
    });
    return () => {
      cancel();
      signal.removeEventListener("abort", cancel);
    };
  }, [scroller, settled, messageId, signal, ready, complete]);
}
