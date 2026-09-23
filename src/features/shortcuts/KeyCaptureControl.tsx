// DESIGN PASS PENDING: provisional black-and-white UI; not yet part of the design system.
import { useEffect, useRef } from "react";
import type { KeyBinding } from "./bindings";
import styles from "./KeyCaptureControl.module.css";

export type CapturedChord = Readonly<{
  binding: KeyBinding;
  /** Control on Apple platforms or Command elsewhere: the dispatcher never matches it. */
  otherPrimary: boolean;
}>;

const MODIFIER_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "OS",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);

/**
 * Focused listening control. Its own keydown handler consumes the event before
 * the window dispatcher sees it, so the shortcut being rebound never fires.
 * Escape (whatever else is held) and losing focus cancel; the owner decides
 * whether a chord is accepted.
 */
export function KeyCaptureControl({
  apple,
  label,
  describedBy,
  onCapture,
  onCancel,
}: {
  apple: boolean;
  label: string;
  describedBy?: string | undefined;
  onCapture: (chord: CapturedChord) => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <input
      ref={input}
      type="text"
      readOnly
      value="Press a shortcut…"
      aria-label={label}
      aria-describedby={describedBy}
      data-state="listening"
      data-design-pass="pending"
      className={`${styles.listening} text-mono-sm`}
      onBlur={onCancel}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        event.stopPropagation();
        if (MODIFIER_KEYS.has(event.key)) return;
        // Someone pressing Shift+Escape or Command+Escape is backing out, not
        // choosing a binding, so Escape never reaches onCapture.
        if (event.key === "Escape") {
          onCancel();
          return;
        }
        // AltGr can report Control+Alt, but the dispatcher always ignores it.
        if (event.getModifierState("AltGraph")) return;
        const mod = apple ? event.metaKey : event.ctrlKey;
        onCapture({
          binding: {
            key: event.key.length === 1 ? event.key.toLowerCase() : event.key,
            ...(mod && { mod }),
            ...(event.shiftKey && { shift: true }),
            ...(event.altKey && { alt: true }),
          },
          otherPrimary: apple ? event.ctrlKey : event.metaKey,
        });
      }}
    />
  );
}
