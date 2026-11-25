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
import {
  MAX_EMOJI_SIZE,
  MIN_EMOJI_SIZE,
  parseEmojiSize,
} from "../../shared/theme/service";
import { EmojiSizeContext, type EmojiSizePreference } from "./emoji-size";
import styles from "./Messages.module.css";

/** Travel below this is a click, which changes nothing. */
const SLOP = 4;
/** Arrow keys step this many percent. */
const KEY_STEP = 10;
/** Emoji pixels per percent when the glyphs can't be measured. */
const FALLBACK_PX_PER_PERCENT = 0.42;

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
  // reflow under the pointer. Every emoji-only message follows on release,
  // at exactly the size the drag stopped on.
  const [preview, setPreview] = useState<number | null>(null);
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    start: number;
    pxPerPercent: number;
    size: number | null;
  } | null>(null);
  const shown = preview ?? saved;
  const save = (size: number) => {
    if (size !== preference.snapshot().emojiSize) preference.setEmojiSize(size);
  };
  const end = (commit: boolean, pointer?: number) => {
    const active = drag.current;
    if (!active || (pointer !== undefined && pointer !== active.pointer))
      return;
    drag.current = null;
    if (commit && active.size !== null) save(active.size);
    setPreview(null);
  };
  const onPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    // Keep the press from starting a text selection or focusing the row.
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    // The glyphs' rendered size turns pointer travel into percent, so the
    // corner keeps pace with the pointer at any interface size.
    const glyphs = event.currentTarget.parentElement?.querySelector(
      "[data-single-emoji]",
    );
    const px = glyphs
      ? Number.parseFloat(getComputedStyle(glyphs).fontSize)
      : 0;
    drag.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      start: saved,
      pxPerPercent: px > 0 ? px / saved : FALLBACK_PX_PER_PERCENT,
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
    if (active.size === null && Math.hypot(dx, dy) < SLOP) return;
    active.size = parseEmojiSize(
      active.start + (dx + dy) / 2 / active.pxPerPercent,
    );
    setPreview(active.size);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Escape" && drag.current) {
      event.preventDefault();
      end(false);
      return;
    }
    const next = {
      ArrowUp: shown + KEY_STEP,
      ArrowRight: shown + KEY_STEP,
      ArrowDown: shown - KEY_STEP,
      ArrowLeft: shown - KEY_STEP,
      Home: MIN_EMOJI_SIZE,
      End: MAX_EMOJI_SIZE,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    save(parseEmojiSize(next));
  };
  return (
    <div
      className={styles.resizableEmoji}
      data-emoji-scale-preview={preview === null ? undefined : ""}
      data-resizing={preview === null ? undefined : ""}
      style={
        preview === null
          ? undefined
          : ({ "--buzz-emoji-scale": preview / 100 } as CSSProperties)
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
          aria-valuemin={MIN_EMOJI_SIZE}
          aria-valuemax={MAX_EMOJI_SIZE}
          aria-valuenow={shown}
          aria-valuetext={`${shown}%`}
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
