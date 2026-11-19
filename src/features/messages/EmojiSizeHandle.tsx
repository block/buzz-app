import {
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
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
};
/** Diagonal pointer travel, in pixels, that moves one size. */
const STEP = 16;
/** Travel below this is a click, which steps to the next size. */
const SLOP = 4;

const LAST = EMOJI_SIZES.length - 1;
/** The size at a step, held to the smallest and largest. */
const sizeAt = (index: number): EmojiSize =>
  EMOJI_SIZES[Math.min(LAST, Math.max(0, index))] ?? "default";

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
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    start: number;
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
    const steps = Math.round((dx + dy) / 2 / STEP);
    active.size = sizeAt(active.start + steps);
    setPreview(active.size);
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
