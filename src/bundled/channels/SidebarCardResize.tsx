import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { readView, subscribeView, writeView } from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import { needsYou } from "./conversation-rows";
import styles from "./Channels.module.css";

/** Conversations each card shows. The earlier pixel heights, saved under
 * "sidebar:card-heights", are no longer read: those cards show the default. */
const sizesKey = "sidebar:card-sizes";
/** Conversations a card shows until its grip is dragged, and after full is
 * toggled off. */
const DEFAULT_SIZE = 7;
/** The saved size of a card opened full. */
const ALL = Number.MAX_SAFE_INTEGER;

function savedSizes(scope: string): Record<string, number> {
  const saved = readView<unknown>(scope, sizesKey, {});
  return saved && typeof saved === "object" && !Array.isArray(saved)
    ? Object.fromEntries(
        Object.entries(saved).filter(
          (entry): entry is [string, number] =>
            Number.isInteger(entry[1]) && entry[1] > 0,
        ),
      )
    : {};
}

/**
 * A card's size, remembered on this device: how many conversations it shows,
 * the same in a list or as icons, or full. Only the grip sets it. Toggling
 * opens a card full, and closes a full card back to the default.
 */
export function useSidebarCardSize(scope: string, card: string) {
  const size = useSyncExternalStore(
    (change) => subscribeView(scope, change),
    () => savedSizes(scope)[card],
  );
  const resize = (next: number | undefined) => {
    const { [card]: _, ...rest } = savedSizes(scope);
    writeView(
      scope,
      sizesKey,
      next === undefined ? rest : { ...rest, [card]: next },
    );
  };
  const toggle = () => resize(size === ALL ? undefined : ALL);
  return [size, resize, toggle] as const;
}

/**
 * A card's conversations and the grip on its bottom edge. A list shows exactly
 * the card's size; tiles that wrap show it rounded up to fill their last row,
 * without saving that. Full shows every one. The drag follows the pointer
 * exactly, then settles onto the nearest whole row (of rows or tiles) on
 * release and saves how many show; the bottom stop is full. Double-click or
 * Enter opens full, and closes full back to the default. Conversations are the
 * descendants marked `data-card-row`.
 */
export function SidebarCardResize({
  label,
  size,
  onResize,
  onToggle,
  children,
}: {
  label: string;
  /** Conversations to show, ALL for full, or undefined for the default. */
  size: number | undefined;
  /** How many the grip settled on, ALL at its bottom stop. */
  onResize(size: number): void;
  /** Open full, or close full back to the default. */
  onToggle(): void;
  children: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLHRElement>(null);
  const stop = useRef<() => void>(undefined);
  useEffect(() => () => stop.current?.(), []);
  const [count, setCount] = useState(0);
  // Rows the card shows now, for assistive technology.
  const [shown, setShown] = useState(0);
  // Conversations past the edge that wait on you, and the lowest one's row.
  const [waiting, setWaiting] = useState<Waiting>(none);
  const apply = useCallback((rows: HTMLElement, size: number | undefined) => {
    setShown(clip(rows, size));
    const next = waitingPastEdge(rows);
    setWaiting((previous) =>
      previous.count === next.count && previous.lowest === next.lowest
        ? previous
        : next,
    );
  }, []);
  const saved = useRef(size);
  // Apply the saved size before paint, and again whenever rows come, go,
  // re-wrap or first get a size (a card opened after starting closed). Only
  // the grip saves a size; settling never does.
  useLayoutEffect(() => {
    saved.current = size;
    if (list.current && !stop.current) apply(list.current, size);
  }, [size, apply]);
  useEffect(() => {
    const rows = list.current;
    if (!rows) return;
    const update = () => {
      setCount(rows.querySelectorAll("[data-card-row]").length);
      if (!stop.current) apply(rows, saved.current);
    };
    update();
    // Observers settle at most once a frame: resizing the sidebar reports a
    // size every frame, and re-wrapping icon tiles reports again.
    let frame: number | undefined;
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      frame = requestAnimationFrame(() => {
        pending = false;
        update();
      });
    };
    // A row, or a row's needs-you marker, arriving or leaving.
    const matters = (node: Node) =>
      node instanceof Element &&
      (node.matches(watched) || !!node.querySelector(watched));
    // Only rows coming or going, a row starting or stopping needing you, or
    // another conversation opening change what the card shows; other badges
    // don't.
    const added = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.type === "attributes" ||
            [...record.addedNodes, ...record.removedNodes].some(matters),
        )
      )
        schedule();
    });
    added.observe(rows, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-channel-needs-you", "aria-current"],
    });
    const sized =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    sized?.observe(rows);
    return () => {
      if (pending && frame !== undefined) cancelAnimationFrame(frame);
      added.disconnect();
      sized?.disconnect();
    };
  }, [apply]);

  return (
    <>
      <div className={styles.cardBody} data-card-body="">
        <div ref={list} className={styles.cardRows} data-card-rows="">
          {children}
        </div>
        {waiting.count > 0 && (
          <div className={styles.cardWaiting} data-card-waiting="">
            <Button
              variant="prominent"
              size="xs"
              shape="capsule"
              type="button"
              aria-label={`Show ${waiting.count} unread ${waiting.count === 1 ? "conversation" : "conversations"} below in ${label}`}
              onClick={(event) => {
                const rows = list.current;
                if (!rows) return;
                // Open just far enough to show the lowest one.
                const next = waiting.lowest + 1;
                onResize(
                  next >= rows.querySelectorAll("[data-card-row]").length
                    ? ALL
                    : next,
                );
                // From the keyboard, keep focus on the card as the badge goes.
                if (event.detail === 0) handle.current?.focus();
              }}
            >
              {waiting.count} unread
            </Button>
          </div>
        )}
      </div>
      {/* Only a card with more than one row has anything to hide. */}
      {count > 1 && (
        <hr
          ref={handle}
          className={styles.cardResize}
          aria-label={`Resize ${label}`}
          aria-orientation="horizontal"
          aria-valuemin={1}
          aria-valuemax={count}
          aria-valuenow={shown}
          aria-valuetext={`${shown} of ${count} conversations`}
          // Rows past the edge keep the handle showing, so the card reads
          // as having more.
          data-more={shown < count ? "" : undefined}
          aria-keyshortcuts="Enter"
          tabIndex={0}
          onDoubleClick={onToggle}
          onKeyDown={(event) => {
            const rows = list.current;
            if (!rows || event.altKey || event.ctrlKey || event.metaKey) return;
            if (event.key === "Enter") {
              event.preventDefault();
              return onToggle();
            }
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            // Step one whole row from where the shown rows end now, not counting
            // a pinned one.
            const pinned = unpin(rows);
            const ends = stops(rows);
            const [first, last] = [ends[0], ends.at(-1)];
            if (first === undefined || last === undefined) return;
            const current = pinned
              ? (ends[shown - 1] ?? rows.offsetHeight)
              : rows.offsetHeight;
            const target = through(
              ends,
              event.key === "ArrowUp"
                ? (ends.filter((end) => end < current - 1).at(-1) ?? first)
                : (ends.find((end) => end > current + 1) ?? last),
            );
            if (target === size) apply(rows, size);
            else onResize(target);
          }}
          onPointerDown={(event) => {
            const rows = list.current;
            if (event.button !== 0 || stop.current || !rows) return;
            event.preventDefault();
            const { pointerId, clientY: startY } = event;
            // The drag moves the edge of the shown rows; a pinned row goes back
            // to its place until the card settles.
            const pinned = unpin(rows);
            const ends = stops(rows);
            const start = pinned
              ? (ends[shown - 1] ?? rows.offsetHeight)
              : rows.offsetHeight;
            const [min = 0] = ends;
            const max = ends.at(-1) ?? start;
            // Rows sliding under the pointer must not take hover mid-drag. The
            // grip stays hit-testable, so a double-click still lands on it.
            const surface = rows.closest("nav") ?? rows;
            const grip = event.currentTarget;
            let next = start;
            let frame: number | undefined;
            // Preview on the element; the saved size changes on release.
            const move = (event: PointerEvent) => {
              if (event.pointerId !== pointerId) return;
              event.preventDefault();
              next = Math.min(
                max,
                Math.max(min, start + event.clientY - startY),
              );
              frame ??= requestAnimationFrame(() => {
                frame = undefined;
                rows.style.maxHeight = `${next}px`;
              });
            };
            const finish = (event: Event) => {
              if ("pointerId" in event && event.pointerId !== pointerId) return;
              stop.current?.();
              // Released, the list glides onto the nearest whole row. Dragged
              // to the bottom, it keeps showing every row as new ones arrive.
              // A click without a drag (half of a double-click) changes nothing.
              if (event.type !== "pointerup" || next === start)
                return apply(rows, size);
              const ends = stops(rows);
              const target = through(ends, nearest(ends, next));
              if (target === size) apply(rows, size);
              else onResize(target);
            };
            stop.current = () => {
              stop.current = undefined;
              if (frame !== undefined) cancelAnimationFrame(frame);
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", finish);
              window.removeEventListener("pointercancel", finish);
              window.removeEventListener("blur", finish);
              handle.current?.removeAttribute("data-resizing");
              rows.removeAttribute("data-resizing");
              document.documentElement.style.removeProperty("cursor");
              document.body.style.removeProperty("user-select");
              surface.style.removeProperty("pointer-events");
              grip.style.removeProperty("pointer-events");
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", finish);
            window.addEventListener("pointercancel", finish);
            window.addEventListener("blur", finish);
            event.currentTarget.setAttribute("data-resizing", "");
            rows.setAttribute("data-resizing", "");
            rows.style.maxHeight = `${start}px`;
            document.documentElement.style.cursor = "grabbing";
            document.body.style.userSelect = "none";
            surface.style.pointerEvents = "none";
            grip.style.pointerEvents = "auto";
          }}
        />
      )}
    </>
  );
}

/**
 * Clip the list to a saved size: the default when unset, none when full. Tiles
 * round up to fill their last row. Rows past the clip are inert, so focus and
 * the keyboard skip what the card hides. Returns how many rows show.
 */
function clip(list: HTMLElement, size: number | undefined): number {
  unpin(list);
  const ends = stops(list);
  const total = ends.length;
  const wanted = Math.min(size ?? DEFAULT_SIZE, total);
  // A hidden card has no layout, so every stop is zero: show the count as it
  // is until the card is shown and can be measured.
  const laidOut = (ends.at(-1) ?? 0) > 0;
  const shown =
    laidOut && wanted > 0
      ? Math.min(through(ends, ends[wanted - 1] ?? 0), total)
      : wanted;
  const clipped = shown < total;
  const end = ends[shown - 1] ?? 0;
  const rows = [...list.querySelectorAll<HTMLElement>("[data-card-row]")];
  // The open conversation never hides past the edge: it shows as one more row
  // (or tile line) under the last one, until another is opened.
  const open = rows.findIndex((row) =>
    row.querySelector('[aria-current="page"]'),
  );
  const pinned = clipped && laidOut && open >= shown ? rows[open] : undefined;
  let room = 0;
  if (pinned) {
    const top = list.getBoundingClientRect().top - list.scrollTop;
    room = (ends[open] ?? 0) - (pinned.getBoundingClientRect().top - top);
    // Writes only what changed: style and attribute writes wake the unread cue.
    const at = `${end}px`;
    if (pinned.style.getPropertyValue("--card-pin-top") !== at)
      pinned.style.setProperty("--card-pin-top", at);
    pinned.setAttribute("data-card-pinned", "");
  }
  setMaxHeight(list, clipped && laidOut ? `${end + room}px` : "");
  rows.forEach((row, index) => {
    const hidden = index >= shown && row !== pinned;
    // Only undo inertness this clip gave: a row leaving the list keeps its own.
    // Unchanged writes are skipped, so they don't wake the unread edge cue.
    if (hidden !== row.hasAttribute("data-card-clipped")) {
      if (hidden || row.inert) row.inert = hidden;
      row.toggleAttribute("data-card-clipped", hidden);
    } else if (hidden && !row.inert) row.inert = true;
  });
  return shown;
}

/** Put a pinned row back in its place, so the list measures as it is. */
function unpin(list: HTMLElement) {
  const pinned = list.querySelector<HTMLElement>("[data-card-pinned]");
  pinned?.removeAttribute("data-card-pinned");
  return !!pinned;
}

function setMaxHeight(list: HTMLElement, value: string) {
  if (list.style.maxHeight !== value) list.style.maxHeight = value;
}

const watched = "[data-card-row], [data-channel-needs-you]";

type Waiting = { count: number; lowest: number };
const none: Waiting = { count: 0, lowest: -1 };

/**
 * Conversations past the card's edge that need you, counted once each, and
 * the index of the lowest one's row.
 */
function waitingPastEdge(list: HTMLElement): Waiting {
  const seen = new Set<string>();
  let lowest = -1;
  list
    .querySelectorAll<HTMLElement>("[data-card-row]")
    .forEach((row, index) => {
      if (!row.hasAttribute("data-card-clipped")) return;
      const button = row.querySelector<HTMLElement>(
        "button[data-channel-id], button[data-solo-channel-id]",
      );
      if (!button || !needsYou(button)) return;
      seen.add(button.dataset.channelId ?? button.dataset.soloChannelId ?? "");
      lowest = index;
    });
  return seen.size ? { count: seen.size, lowest } : none;
}

/**
 * Where the list ends after each of its rows: where the next line starts, so
 * tiles sharing a line share an end.
 */
function stops(list: HTMLElement) {
  const top = list.getBoundingClientRect().top - list.scrollTop;
  const tops = [...list.querySelectorAll<HTMLElement>("[data-card-row]")].map(
    (row) => row.getBoundingClientRect().top - top,
  );
  return tops.map((own, index) => {
    const next = tops.find((other, later) => later > index && other > own + 1);
    return Math.round(next ?? list.scrollHeight);
  });
}

/** How many rows show when the list ends at `end`, ALL when every one does. */
function through(ends: readonly number[], end: number) {
  const shown = ends.filter((each) => each <= end).length;
  return shown >= ends.length ? ALL : Math.max(1, shown);
}

/** The whole-row end closest to a dragged height. */
function nearest(ends: readonly number[], height: number) {
  return ends.reduce(
    (best, end) =>
      Math.abs(end - height) < Math.abs(best - height) ? end : best,
    Number.POSITIVE_INFINITY,
  );
}
