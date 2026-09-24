import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import styles from "./AttachmentPoof.module.css";

const frames = [1, 2, 3, 4, 5];
const asset = (name: string) => `${import.meta.env.BASE_URL}pow/${name}`;
type Burst = { id: number; x: number; y: number; size: number };

// Owned by the attachment list, so removing its last item cannot erase the puff.
export function useAttachmentPoof() {
  const [bursts, setBursts] = useState<Burst[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    for (const frame of frames) new Image().src = asset(`poof${frame}@3x.png`);
    try {
      audio.current = new Audio(asset("plop.m4a"));
      audio.current.preload = "auto";
      audio.current.volume = 0.34;
    } catch {
      // Sound is optional; removal must work without audio support.
    }
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
      audio.current?.pause();
      audio.current = null;
    };
  }, []);

  function emit(origin: DOMRect) {
    const id = nextId.current++;
    setBursts((current) => [
      ...current.slice(-5),
      {
        id,
        x: origin.left + origin.width / 2,
        y: origin.top + origin.height / 2,
        size: Math.min(Math.max(origin.width * 0.54, 104), 190) * 0.6375,
      },
    ]);
    try {
      if (audio.current) {
        audio.current.currentTime = 0;
        void audio.current.play().catch(() => {});
      }
    } catch {
      // Browser playback policy must never interfere with removal.
    }
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setBursts((current) => current.filter((burst) => burst.id !== id));
    }, 430);
    timers.current.add(timer);
  }

  return {
    emit,
    overlay: bursts.length
      ? createPortal(
          <div
            className={styles.layer}
            aria-hidden="true"
            data-attachment-poof=""
          >
            {bursts.map((burst) => (
              <div
                key={burst.id}
                className={styles.burst}
                style={
                  {
                    "--buzz-poof-size": `${burst.size}px`,
                    "--buzz-poof-x": `${burst.x}px`,
                    "--buzz-poof-y": `${burst.y}px`,
                  } as CSSProperties
                }
              >
                {frames.map((frame) => (
                  <img
                    key={frame}
                    className={`${styles.frame} ${styles[`frame${frame}`]}`}
                    src={asset(`poof${frame}@3x.png`)}
                    alt=""
                    draggable={false}
                  />
                ))}
              </div>
            ))}
          </div>,
          document.body,
        )
      : null,
  };
}
