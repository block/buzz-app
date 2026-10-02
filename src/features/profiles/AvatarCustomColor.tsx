import { useRef, useState, type PointerEvent } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./AvatarCustomColor.module.css";

const clamp = (value: number) => Math.max(0, Math.min(100, value));

function fromHex(hex: string) {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const [r = 0, g = 0, b = 0] = channels;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  const hue = !delta
    ? 0
    : max === r
      ? (g - b) / delta
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return {
    hue: (hue * 60 + 360) % 360,
    saturation: max ? (delta / max) * 100 : 0,
    value: max * 100,
  };
}

function toHex({ hue, saturation, value }: ReturnType<typeof fromHex>) {
  const s = saturation / 100;
  const v = value / 100;
  return `#${[5, 3, 1]
    .map((n) => {
      const k = (n + hue / 60) % 6;
      return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")
    .toUpperCase()}`;
}

/** Continuous color spectrum and hue scrubber, with keyboard adjustment. */
export function AvatarCustomColor({
  color,
  disabled,
  onChange,
  onClose,
}: {
  color: string;
  disabled: boolean;
  onChange(color: string): void;
  onClose(): void;
}) {
  const [hsv, setHsv] = useState(() => fromHex(color));
  const drag = useRef<number | null>(null);
  const update = (next: Partial<typeof hsv>) => {
    const result = { ...hsv, ...next };
    setHsv(result);
    onChange(toHex(result));
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    update({
      saturation: clamp(
        ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100,
      ),
      value: clamp(
        (1 - (event.clientY - rect.top) / Math.max(1, rect.height)) * 100,
      ),
    });
  };
  return (
    <div className={styles.panel} inert={disabled}>
      <div
        className={styles.spectrum}
        role="slider"
        tabIndex={0}
        aria-label="Color spectrum"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.saturation)}
        aria-valuetext={`${Math.round(hsv.saturation)}% saturation, ${Math.round(hsv.value)}% brightness. Use left and right for saturation, up and down for brightness.`}
        style={{ backgroundColor: `hsl(${hsv.hue}, 100%, 50%)` }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          drag.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          move(event);
        }}
        onPointerMove={(event) => {
          if (drag.current === event.pointerId) move(event);
        }}
        onPointerUp={(event) => {
          if (drag.current !== event.pointerId) return;
          move(event);
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          const adjustments: Record<string, Partial<typeof hsv>> = {
            ArrowLeft: { saturation: clamp(hsv.saturation - 1) },
            ArrowRight: { saturation: clamp(hsv.saturation + 1) },
            ArrowDown: { value: clamp(hsv.value - 1) },
            ArrowUp: { value: clamp(hsv.value + 1) },
            Home: { saturation: 0 },
            End: { saturation: 100 },
          };
          const next = adjustments[event.key];
          if (next) {
            event.preventDefault();
            update(next);
          }
        }}
      >
        <div className={styles.grid} aria-hidden="true">
          <span
            className={styles.thumb}
            style={{
              left: `${hsv.saturation}%`,
              top: `${100 - hsv.value}%`,
              backgroundColor: toHex(hsv),
            }}
          />
        </div>
      </div>
      <input
        className={styles.hue}
        type="range"
        min={0}
        max={360}
        step={1}
        value={hsv.hue}
        aria-label="Color hue"
        onChange={(event) => update({ hue: Number(event.target.value) })}
      />
      <Button variant="subtle" onClick={onClose}>
        Use color
      </Button>
    </div>
  );
}
