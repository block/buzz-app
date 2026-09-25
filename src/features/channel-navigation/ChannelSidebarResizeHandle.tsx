import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  CHANNEL_SIDEBAR_DEFAULT_WIDTH,
  CHANNEL_SIDEBAR_MIN_WIDTH,
  CHANNEL_SIDEBAR_MAX_WIDTH,
} from "../../bundled/channels/useSidebarView";
import styles from "../../bundled/channels/Channels.module.css";

export function ChannelSidebarResizeHandle({
  width,
  setWidth,
}: {
  width: number;
  setWidth(width: number): void;
}) {
  const handle = useRef<HTMLHRElement>(null);
  const [renderedWidth, setRenderedWidth] = useState(width);
  const drag = useRef<
    { pointerId: number; startX: number; width: number } | undefined
  >(undefined);
  const resize = useRef(setWidth);
  resize.current = setWidth;
  const move = useCallback((event: PointerEvent) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    resize.current(drag.current.width + event.clientX - drag.current.startX);
  }, []);
  const finish = useCallback(() => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    drag.current = undefined;
    delete document.documentElement.dataset.sidebarResizing;
    document.documentElement.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, [move]);
  const measure = useCallback(() => {
    const sidebar = handle.current?.previousElementSibling;
    if (!(sidebar instanceof HTMLElement)) return;
    const next = Math.round(sidebar.getBoundingClientRect().width);
    setRenderedWidth((current) => (current === next ? current : next));
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);
  useEffect(() => () => finish(), [finish]);

  return (
    <hr
      ref={handle}
      className={styles.sidebarResizeHandle}
      aria-label="Resize channel sidebar"
      aria-orientation="vertical"
      aria-valuemin={CHANNEL_SIDEBAR_MIN_WIDTH}
      aria-valuemax={CHANNEL_SIDEBAR_MAX_WIDTH}
      aria-valuenow={Math.round(renderedWidth)}
      tabIndex={0}
      data-tooltip="Drag to resize · Double-click to reset"
      onDoubleClick={() => setWidth(CHANNEL_SIDEBAR_DEFAULT_WIDTH)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        const sidebar = event.currentTarget.previousElementSibling;
        const currentWidth =
          sidebar instanceof HTMLElement
            ? sidebar.getBoundingClientRect().width
            : renderedWidth;
        if (event.key === "ArrowLeft") setWidth(currentWidth - step);
        else if (event.key === "ArrowRight") setWidth(currentWidth + step);
        else if (event.key === "Home") setWidth(CHANNEL_SIDEBAR_MIN_WIDTH);
        else if (event.key === "End") setWidth(CHANNEL_SIDEBAR_MAX_WIDTH);
        else return;
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const sidebar = event.currentTarget.previousElementSibling;
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          width:
            sidebar instanceof HTMLElement
              ? sidebar.getBoundingClientRect().width
              : renderedWidth,
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish, { once: true });
        window.addEventListener("pointercancel", finish, { once: true });
        document.documentElement.dataset.sidebarResizing = "true";
        document.documentElement.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
    />
  );
}
