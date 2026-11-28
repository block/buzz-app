import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "../../../shared/design-system/ui/Button";
import { MinusIcon, PlusIcon } from "../../../shared/design-system/icons";
import type { CanvasViewProps, CanvasViewType } from "../view";
import styles from "./views.module.css";

type Point = readonly [lng: number, lat: number];
export type MapState = {
  center: Point;
  zoom: number;
  markers: readonly { coordinates: Point; label?: string }[];
};

const TILE = 256;
const MAX_ZOOM = 19;
const MAX_MARKERS = 200;
/** The furthest north and south a Web Mercator map reaches. */
const MAX_LAT = 85.0511;

const point = (input: unknown): Point | undefined =>
  Array.isArray(input) &&
  input.length === 2 &&
  input.every((value) => typeof value === "number" && Number.isFinite(value)) &&
  Math.abs(input[0]) <= 180 &&
  Math.abs(input[1]) <= 90
    ? [input[0], input[1]]
    : undefined;

function parse(input: unknown): MapState | undefined {
  const value = input as {
    center?: unknown;
    zoom?: unknown;
    markers?: unknown;
  } | null;
  const center = point(value?.center);
  const zoom = value?.zoom;
  if (
    !center ||
    typeof zoom !== "number" ||
    !(zoom >= 0 && zoom <= MAX_ZOOM) ||
    (value?.markers !== undefined && !Array.isArray(value.markers))
  )
    return;
  const markers: MapState["markers"][number][] = [];
  for (const entry of (value?.markers as unknown[] | undefined) ?? []) {
    const marker = entry as { coordinates?: unknown; label?: unknown } | null;
    const coordinates = point(marker?.coordinates);
    if (!coordinates || markers.length >= MAX_MARKERS) return;
    markers.push({
      coordinates,
      ...(typeof marker?.label === "string" && marker.label.trim()
        ? { label: marker.label.trim().slice(0, 200) }
        : {}),
    });
  }
  return { center, zoom: Math.round(zoom), markers };
}

/** Web Mercator: a place's position in pixels on the whole world at `zoom`. */
const project = ([lng, lat]: Point, zoom: number) => {
  const size = TILE * 2 ** zoom;
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
};
const unproject = (x: number, y: number, zoom: number): Point => {
  const size = TILE * 2 ** zoom;
  const lng = (x / size) * 360 - 180;
  const lat =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / size))) * 180) / Math.PI;
  return [
    Math.max(-180, Math.min(180, lng)),
    Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)),
  ];
};

function MapView({
  state,
  interactive,
  update,
  tiles,
}: CanvasViewProps<MapState> & { tiles: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () =>
      setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // While dragging, the map follows the pointer; the move is shared on release.
  const [drag, setDrag] = useState<{
    startX: number;
    startY: number;
    x: number;
    y: number;
  }>();
  const { zoom } = state;
  const origin = project(state.center, zoom);
  const centerX = origin.x - (drag ? drag.x - drag.startX : 0);
  const centerY = origin.y - (drag ? drag.y - drag.startY : 0);
  const left = centerX - size.width / 2;
  const top = centerY - size.height / 2;
  const count = 2 ** zoom;
  const images = [];
  if (size.width && size.height)
    for (
      let row = Math.max(0, Math.floor(top / TILE));
      row <= Math.min(count - 1, Math.floor((top + size.height) / TILE));
      row++
    )
      for (
        let column = Math.floor(left / TILE);
        column <= Math.floor((left + size.width) / TILE);
        column++
      ) {
        // The world repeats sideways, so a column wraps round to a real tile.
        const wrapped = ((column % count) + count) % count;
        images.push(
          <img
            key={`${zoom}/${column}/${row}`}
            className={styles.tile}
            alt=""
            draggable={false}
            src={tiles
              .replace("{z}", String(zoom))
              .replace("{x}", String(wrapped))
              .replace("{y}", String(row))}
            style={{ left: column * TILE - left, top: row * TILE - top }}
          />,
        );
      }
  const release = (event: PointerEvent) => {
    if (!drag) return;
    setDrag(undefined);
    if (
      event.type === "pointerup" &&
      (centerX !== origin.x || centerY !== origin.y)
    )
      update({ ...state, center: unproject(centerX, centerY, zoom) });
  };
  const zoomTo = (next: number) =>
    update({ ...state, zoom: Math.max(0, Math.min(MAX_ZOOM, next)) });
  return (
    <div className={styles.fill}>
      <div
        ref={frame}
        className={styles.map}
        role="application"
        aria-label="Map"
        data-dragging={drag ? "" : undefined}
        onPointerDown={(event) => {
          if (!interactive || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({
            startX: event.clientX,
            startY: event.clientY,
            x: event.clientX,
            y: event.clientY,
          });
        }}
        onPointerMove={(event) =>
          setDrag(
            (current) =>
              current && { ...current, x: event.clientX, y: event.clientY },
          )
        }
        onPointerUp={release}
        onPointerCancel={release}
      >
        {images}
        {state.markers.map((marker, index) => {
          const at = project(marker.coordinates, zoom);
          return (
            <div
              // Markers have no identity but their place in the list.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above.
              key={index}
              className={styles.pin}
              style={{ left: at.x - left, top: at.y - top }}
            >
              {marker.label && (
                <span className={styles.pinLabel}>{marker.label}</span>
              )}
              <span className={styles.pinDot} />
            </div>
          );
        })}
        {interactive && (
          <div
            className={styles.mapControls}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Button
              variant="outline"
              size="sm"
              shape="icon"
              aria-label="Zoom in"
              disabled={zoom >= MAX_ZOOM}
              onClick={() => zoomTo(zoom + 1)}
            >
              <PlusIcon size={16} aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              shape="icon"
              aria-label="Zoom out"
              disabled={zoom <= 0}
              onClick={() => zoomTo(zoom - 1)}
            >
              <MinusIcon size={16} aria-hidden="true" />
            </Button>
          </div>
        )}
        <span className={styles.credit}>© OpenStreetMap contributors</span>
      </div>
    </div>
  );
}

const place = ([lng, lat]: Point) => `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

/** A map drawn from raster tiles, with no map library or API key. `tiles` is a
 * `{z}/{x}/{y}` address template. */
export const mapView = (
  tiles = "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
): CanvasViewType<MapState> => ({
  type: "map",
  title: "Map",
  initial: { center: [0, 20], zoom: 2, markers: [] },
  parse,
  describe: (state) =>
    `A map centred on ${place(state.center)} at zoom ${state.zoom}${
      state.markers.length
        ? `, with ${state.markers.length} marker${state.markers.length === 1 ? "" : "s"}: ${state.markers
            .slice(0, 20)
            .map((marker) => marker.label ?? place(marker.coordinates))
            .join("; ")}`
        : ""
    }.`,
  component: (props) => <MapView {...props} tiles={tiles} />,
});
