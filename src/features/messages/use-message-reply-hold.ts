import { useEffect, useRef, type PointerEvent } from "react";

/** A preview can be committed on release or withdrawn without taking focus. */
export type ReplyHold = { commit(): void; cancel(): void };

/** Holding prose previews a reply; selection, scrolling and embedded controls win. */
export function useMessageReplyHold(
  id: string,
  reply: ((deferFocus?: boolean) => ReplyHold | undefined) | undefined,
) {
  const latest = useRef(reply);
  latest.current = reply;
  const hold = useRef<{ id: string; cancel(): void } | undefined>(undefined);
  const cancel = () => hold.current?.cancel();
  const enabled = !!reply;
  useEffect(() => {
    if (!enabled || hold.current?.id !== id) hold.current?.cancel();
    return () => hold.current?.cancel();
  }, [id, enabled]);
  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      const target = event.target as Element;
      if (
        !latest.current ||
        hold.current ||
        event.button !== 0 ||
        event.isPrimary === false ||
        event.defaultPrevented ||
        target.closest(
          "a, button, input, textarea, select, summary, audio, video, [role='button'], [role='link'], [role='menuitem'], [contenteditable='true']",
        ) ||
        !target.ownerDocument.getSelection()?.isCollapsed
      )
        return;
      const doc = target.ownerDocument;
      const win = doc.defaultView;
      const { clientX: x, clientY: y, pointerId } = event;
      let preview: ReplyHold | undefined;
      const clear = () => {
        clearTimeout(timer);
        doc.removeEventListener("scroll", abort, true);
        doc.removeEventListener("selectionchange", selectionChanged);
        doc.removeEventListener("pointermove", move);
        doc.removeEventListener("pointerup", release);
        doc.removeEventListener("pointercancel", abort);
        win?.removeEventListener("blur", abort);
        hold.current = undefined;
      };
      const abort = () => {
        clear();
        preview?.cancel();
      };
      const selectionChanged = () => {
        if (!doc.getSelection()?.isCollapsed) abort();
      };
      const move = (next: globalThis.PointerEvent) => {
        if (
          next.pointerId === pointerId &&
          Math.hypot(next.clientX - x, next.clientY - y) > 5
        )
          abort();
      };
      const release = (next: globalThis.PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        clear();
        if (doc.getSelection()?.isCollapsed) preview?.commit();
        else preview?.cancel();
      };
      const timer = setTimeout(() => {
        if (target.isConnected && doc.getSelection()?.isCollapsed)
          preview = latest.current?.(true);
        else abort();
      }, 100);
      hold.current = { id, cancel: abort };
      doc.addEventListener("scroll", abort, true);
      doc.addEventListener("selectionchange", selectionChanged);
      doc.addEventListener("pointermove", move);
      doc.addEventListener("pointerup", release);
      doc.addEventListener("pointercancel", abort);
      win?.addEventListener("blur", abort);
    },
    onPointerLeave: cancel,
    onContextMenu: cancel,
  };
}
