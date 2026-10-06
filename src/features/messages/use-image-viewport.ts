import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

type Point = Readonly<{ x: number; y: number }>;
type Viewport = { zoom: number; offset: Point };
type Gesture = Event & { scale: number; clientX: number; clientY: number };
const initial: Viewport = { zoom: 1, offset: { x: 0, y: 0 } };
export const MIN_ZOOM = 0.5;
const BASE_MAX_ZOOM = 4;
// Large images may reach 200% of their intrinsic pixels, past the base limit.
const maxZoomFor = (fit: number | undefined) =>
  fit ? Math.max(BASE_MAX_ZOOM, 2 / fit) : BASE_MAX_ZOOM;
const clamp = (value: number, limit: number) =>
  Math.max(-limit, Math.min(limit, value));

export function useImageViewport(
  stage: RefObject<HTMLDivElement | null>,
  image: RefObject<HTMLImageElement | null>,
  source: string | undefined,
) {
  const [viewport, setViewport] = useState(initial);
  const [maxZoom, setMaxZoom] = useState(BASE_MAX_ZOOM);
  // Gestures can deliver several events before React renders the next frame.
  const current = useRef(initial);
  useLayoutEffect(() => {
    void source;
    current.current = initial;
    setViewport(initial);
    setMaxZoom(BASE_MAX_ZOOM);
  }, [source]);
  // Converts a client point to an offset from the stage center.
  const stagePoint = useCallback(
    (x: number, y: number) => {
      const bounds = stage.current?.getBoundingClientRect();
      if (!bounds) return { x: 0, y: 0 };
      return {
        x:
          (Number.isFinite(x) ? x : bounds.left + bounds.width / 2) -
          bounds.left -
          bounds.width / 2,
        y:
          (Number.isFinite(y) ? y : bounds.top + bounds.height / 2) -
          bounds.top -
          bounds.height / 2,
      };
    },
    [stage],
  );
  // Display scale of the fitted image; 1 means intrinsic pixels.
  const fitScale = useCallback(() => {
    const bounds = stage.current?.getBoundingClientRect();
    const element = image.current;
    if (!bounds || !element?.naturalWidth || !element.naturalHeight) return;
    return Math.min(
      bounds.width / element.naturalWidth,
      bounds.height / element.naturalHeight,
    );
  }, [stage, image]);
  const limits = useCallback(
    (zoom: number) => {
      const bounds = stage.current?.getBoundingClientRect();
      const element = image.current;
      const fit = fitScale();
      if (!element || !bounds || !fit) return { x: 0, y: 0 };
      return {
        x: Math.max(0, (element.naturalWidth * fit * zoom - bounds.width) / 2),
        y: Math.max(
          0,
          (element.naturalHeight * fit * zoom - bounds.height) / 2,
        ),
      };
    },
    [stage, image, fitScale],
  );
  const update = useCallback(
    (zoom: number, offset: Point) => {
      const bound = limits(zoom);
      const next = {
        zoom,
        offset: { x: clamp(offset.x, bound.x), y: clamp(offset.y, bound.y) },
      };
      const previous = current.current;
      if (
        previous.zoom === next.zoom &&
        previous.offset.x === next.offset.x &&
        previous.offset.y === next.offset.y
      )
        return;
      current.current = next;
      setViewport(next);
    },
    [limits],
  );
  const zoomTo = useCallback(
    (value: number, anchor?: Point) => {
      if (!Number.isFinite(value)) return;
      const max = maxZoomFor(fitScale());
      setMaxZoom(max);
      const zoom = Math.max(MIN_ZOOM, Math.min(max, value));
      const previous = current.current;
      const ratio = zoom / previous.zoom;
      update(
        zoom,
        anchor
          ? {
              x: anchor.x - (anchor.x - previous.offset.x) * ratio,
              y: anchor.y - (anchor.y - previous.offset.y) * ratio,
            }
          : previous.offset,
      );
    },
    [update, fitScale],
  );
  // Click zoom: fit goes to actual pixels for downscaled images, and at least
  // 2x fit otherwise; any other zoom returns to fit.
  const toggleZoomAt = useCallback(
    (clientX: number, clientY: number) => {
      if (current.current.zoom !== 1) return zoomTo(1);
      const fit = fitScale();
      zoomTo(Math.max(2, fit ? 1 / fit : 2), stagePoint(clientX, clientY));
    },
    [zoomTo, fitScale, stagePoint],
  );
  const panTo = useCallback(
    (offset: Point) => update(current.current.zoom, offset),
    [update],
  );
  const constrain = useCallback(() => zoomTo(current.current.zoom), [zoomTo]);
  useEffect(() => {
    const element = stage.current;
    if (!element || !source) return;
    let gestureZoom: number | undefined;
    const fromToolbar = (event: Event) =>
      event.target instanceof Element &&
      !!event.target.closest("[data-image-controls]");
    const wheel = (event: WheelEvent) => {
      if (fromToolbar(event) && !event.ctrlKey) return;
      // Keep gestures local to the image, including at the pan/zoom limits.
      event.preventDefault();
      if (gestureZoom !== undefined) return;
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element.clientHeight
            : 1;
      const dx = event.deltaX * unit,
        dy = event.deltaY * unit;
      if (event.ctrlKey) {
        zoomTo(
          current.current.zoom * Math.exp(-dy * 0.01),
          stagePoint(event.clientX, event.clientY),
        );
      } else if (current.current.zoom > 1) {
        const offset = current.current.offset;
        panTo({ x: offset.x - dx, y: offset.y - dy });
      }
    };
    const start = (event: Event) => {
      event.preventDefault();
      gestureZoom = current.current.zoom;
    };
    const change = (event: Event) => {
      if (gestureZoom === undefined) return;
      event.preventDefault();
      const gesture = event as Gesture;
      zoomTo(
        gestureZoom * gesture.scale,
        stagePoint(gesture.clientX, gesture.clientY),
      );
    };
    const end = (event: Event) => {
      if (gestureZoom === undefined) return;
      event.preventDefault();
      gestureZoom = undefined;
    };
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("gesturestart", start, { passive: false });
    element.addEventListener("gesturechange", change, { passive: false });
    element.addEventListener("gestureend", end, { passive: false });
    // Sidebar motion changes the image's bounds without a window resize.
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(constrain);
    observer?.observe(element);
    window.addEventListener("resize", constrain);
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("gesturestart", start);
      element.removeEventListener("gesturechange", change);
      element.removeEventListener("gestureend", end);
      observer?.disconnect();
      window.removeEventListener("resize", constrain);
    };
  }, [stage, source, stagePoint, zoomTo, panTo, constrain]);
  return { ...viewport, maxZoom, zoomTo, toggleZoomAt, panTo, constrain };
}
