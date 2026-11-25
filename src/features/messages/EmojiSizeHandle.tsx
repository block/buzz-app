import {
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { EMOJI_SIZES, type EmojiSize } from "../../shared/theme/service";
import { EmojiSizeContext, type EmojiSizePreference } from "./emoji-size";
import styles from "./Messages.module.css";

const LABELS: Record<EmojiSize, string> = {
  default: "Default",
  medium: "Medium",
  large: "Large",
  "extra-large": "Extra large",
  huge: "Huge",
};
/** Without measured sizes, the diagonal travel in pixels that moves a size. */
const STEP = 16;
/** Travel below this is a click, which steps to the next size. */
const SLOP = 4;

const LAST = EMOJI_SIZES.length - 1;
/** The size at a step, held to the smallest and largest. */
const sizeAt = (index: number): EmojiSize =>
  EMOJI_SIZES[Math.min(LAST, Math.max(0, index))] ?? "default";

/** Rendered glyph size and line height of one size, in pixels. */
type Stop = { display: number; line: number };

/** Reads each size's rendered metrics from the design tokens, so the drag
    follows them without its own copy of the scale. */
function measureStops(frame: HTMLElement): Stop[] | null {
  const glyphs = frame.querySelector<HTMLElement>("[data-single-emoji]");
  if (!glyphs) return null;
  const { emojiSizePreview: before, resizing } = frame.dataset;
  // Hold the settle animation off, or each read would see the animated size.
  frame.dataset.resizing = "";
  const stops = EMOJI_SIZES.map((size) => {
    frame.dataset.emojiSizePreview = size;
    const style = getComputedStyle(glyphs);
    return {
      display: Number.parseFloat(style.fontSize),
      line: Number.parseFloat(style.lineHeight),
    };
  });
  if (before === undefined) delete frame.dataset.emojiSizePreview;
  else frame.dataset.emojiSizePreview = before;
  // Settle at the current size before the animation can apply again.
  getComputedStyle(glyphs).fontSize;
  if (resizing === undefined) delete frame.dataset.resizing;
  const ascending = stops.every(
    (stop, index) =>
      Number.isFinite(stop.display) &&
      Number.isFinite(stop.line) &&
      (index === 0 || stop.display > (stops[index - 1]?.display ?? 0)),
  );
  return ascending ? stops : null;
}

/** The glyph size and line height between two sizes, and the nearest size. */
function fluidAt(stops: readonly Stop[], display: number) {
  const first = stops[0] as Stop;
  const last = stops[LAST] as Stop;
  const clamped = Math.min(last.display, Math.max(first.display, display));
  let nearest = 0;
  stops.forEach((stop, index) => {
    const best = stops[nearest] as Stop;
    if (Math.abs(stop.display - clamped) < Math.abs(best.display - clamped))
      nearest = index;
  });
  const upper = Math.max(
    1,
    stops.findIndex((stop) => stop.display >= clamped),
  );
  const low = stops[upper - 1] as Stop;
  const high = stops[upper] as Stop;
  const t = (clamped - low.display) / (high.display - low.display);
  return {
    size: sizeAt(nearest),
    display: clamped,
    line: low.line + (high.line - low.line) * t,
  };
}

/** Emoji-only message content with a corner handle that changes the saved
    emoji size for this person. Without a saved preference, only the content. */
export function ResizableEmoji({ children }: { children: ReactNode }) {
  const preference = useContext(EmojiSizeContext);
  return preference ? (
    <EmojiSizeFrame preference={preference}>{children}</EmojiSizeFrame>
  ) : (
    children
  );
}

function EmojiSizeFrame({
  preference,
  children,
}: {
  preference: EmojiSizePreference;
  children: ReactNode;
}) {
  const saved = useSyncExternalStore(
    preference.subscribe,
    () => preference.snapshot().emojiSize,
  );
  // Only this message previews while dragging, so the conversation doesn't
  // reflow under the pointer. Every emoji-only message follows on release.
  const [preview, setPreview] = useState<EmojiSize | null>(null);
  // While dragging, the glyphs follow the pointer between sizes; on release
  // they settle on the nearest size.
  const [fluid, setFluid] = useState<Stop | null>(null);
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    start: number;
    stops: Stop[] | null;
    size: EmojiSize | null;
  } | null>(null);
  const shown = preview ?? saved;
  const index = EMOJI_SIZES.indexOf(shown);
  const save = (size: EmojiSize) => {
    if (size !== preference.snapshot().emojiSize) preference.setEmojiSize(size);
  };
  const end = (commit: boolean, pointer?: number) => {
    const active = drag.current;
    if (!active || (pointer !== undefined && pointer !== active.pointer))
      return;
    drag.current = null;
    if (commit)
      save(active.size ?? sizeAt((active.start + 1) % EMOJI_SIZES.length));
    setPreview(null);
    setFluid(null);
  };
  const onPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    // Keep the press from starting a text selection or focusing the row.
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      start: EMOJI_SIZES.indexOf(saved),
      stops: event.currentTarget.parentElement
        ? measureStops(event.currentTarget.parentElement)
        : null,
      size: null,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    const active = drag.current;
    if (active?.pointer !== event.pointerId) return;
    // Growing pulls the corner away from the emoji: rightward when the handle
    // sits at their right, leftward on your own messages, where it sits left.
    const handle = event.currentTarget.getBoundingClientRect();
    const frame = event.currentTarget.parentElement?.getBoundingClientRect();
    const onLeft = !!frame && handle.left < frame.left + frame.width / 2;
    const dx = (event.clientX - active.x) * (onLeft ? -1 : 1);
    const dy = event.clientY - active.y;
    if (!active.size && Math.hypot(dx, dy) < SLOP) return;
    const travel = (dx + dy) / 2;
    const start = active.stops?.[active.start];
    if (!active.stops || !start) {
      active.size = sizeAt(active.start + Math.round(travel / STEP));
      setPreview(active.size);
      return;
    }
    const next = fluidAt(active.stops, start.display + travel);
    active.size = next.size;
    setPreview(next.size);
    setFluid({ display: next.display, line: next.line });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Escape" && drag.current) {
      event.preventDefault();
      end(false);
      return;
    }
    const next = {
      ArrowUp: index + 1,
      ArrowRight: index + 1,
      ArrowDown: index - 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: LAST,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    save(sizeAt(next));
  };
  return (
    <div
      className={styles.resizableEmoji}
      data-emoji-size-preview={preview ?? undefined}
      data-resizing={preview ? "" : undefined}
      style={
        fluid
          ? ({
              "--size-emoji-display": `${fluid.display}px`,
              "--size-emoji-line": `${fluid.line}px`,
            } as CSSProperties)
          : undefined
      }
    >
      {children}
      <Tooltip content="Drag to resize emoji. Only you see this.">
        <span
          className={styles.emojiSizeHandle}
          role="slider"
          tabIndex={0}
          aria-label="Emoji size, only you see this"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={LAST}
          aria-valuenow={index}
          aria-valuetext={LABELS[shown]}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => end(true, event.pointerId)}
          onPointerCancel={(event) => end(false, event.pointerId)}
          onLostPointerCapture={(event) => end(true, event.pointerId)}
          onKeyDown={onKeyDown}
        />
      </Tooltip>
    </div>
  );
}
