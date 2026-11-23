import { useEffect, useEffectEvent, useRef, useState } from "react";

type Gesture = {
  channelId: string;
  source: "pointer" | "wheel";
  x: number;
  y: number;
  distance: number;
  done: boolean;
  pointerId?: number;
};
const threshold = 100;

/** Keep a trackpad burst bound to one card, including its trailing momentum. */
export function useCatchUpSwipe({
  channelId,
  disabled,
  read,
  keep,
}: {
  channelId: string | undefined;
  disabled: boolean;
  read: () => void;
  keep: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const wheelEnd = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const complete = useEffectEvent((current: Gesture) => {
    current.done = true;
    setOffset(0);
    if (disabled || current.channelId !== channelId) return;
    if (current.distance >= threshold) read();
    else if (current.distance <= -threshold) keep();
  });
  const start = useEffectEvent((event: PointerEvent) => {
    const target = event.target;
    if (
      disabled ||
      !channelId ||
      !event.isPrimary ||
      event.button !== 0 ||
      gesture.current ||
      !(target instanceof Element) ||
      target.closest("button, a, input, textarea, select, [contenteditable]") ||
      (event.pointerType === "mouse" &&
        target.closest("[data-catch-up-message]"))
    )
      return;
    gesture.current = {
      channelId,
      source: "pointer",
      x: event.clientX,
      y: event.clientY,
      distance: 0,
      done: false,
      pointerId: event.pointerId,
    };
    if (event.pointerType === "mouse") event.preventDefault();
    ref.current?.setPointerCapture(event.pointerId);
  });
  const move = useEffectEvent((event: PointerEvent) => {
    const current = gesture.current;
    if (
      current?.source !== "pointer" ||
      current.pointerId !== event.pointerId ||
      current.done
    )
      return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
      current.done = true;
      setOffset(0);
      return;
    }
    current.distance = dx;
    setOffset(Math.max(-120, Math.min(120, dx)));
  });
  const end = useEffectEvent((event: PointerEvent) => {
    const current = gesture.current;
    if (current?.source !== "pointer" || current.pointerId !== event.pointerId)
      return;
    if (event.type === "pointerup" && !current.done) {
      move(event);
      if (!current.done) complete(current);
    }
    gesture.current = undefined;
    setOffset(0);
  });
  const wheel = useEffectEvent((event: WheelEvent) => {
    if (event.ctrlKey || gesture.current?.source === "pointer") return;
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (!gesture.current && (disabled || !channelId)) return;
    if (horizontal) event.preventDefault();
    clearTimeout(wheelEnd.current);
    wheelEnd.current = setTimeout(() => {
      gesture.current = undefined;
      setOffset(0);
    }, 220);
    if (!gesture.current)
      gesture.current = {
        channelId: channelId ?? "",
        source: "wheel",
        x: 0,
        y: 0,
        distance: 0,
        done: !horizontal,
      };
    const current = gesture.current;
    if (current.done) return;
    if (!horizontal) {
      current.done = true;
      setOffset(0);
      return;
    }
    // Natural trackpad scrolling reports the opposite of the card's movement.
    const unit =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? (ref.current?.clientWidth ?? threshold)
          : 1;
    current.distance -= event.deltaX * unit;
    setOffset(Math.max(-120, Math.min(120, current.distance)));
    if (Math.abs(current.distance) >= threshold) complete(current);
  });
  const mounted = !!channelId;
  useEffect(() => {
    const element = ref.current;
    if (!mounted) {
      setOffset(0);
      return;
    }
    if (!element) return;
    element.addEventListener("pointerdown", start);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
    element.addEventListener("lostpointercapture", end);
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      element.removeEventListener("pointerdown", start);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
      element.removeEventListener("lostpointercapture", end);
      element.removeEventListener("wheel", wheel);
      clearTimeout(wheelEnd.current);
      gesture.current = undefined;
    };
  }, [mounted]);
  return { ref, offset };
}
