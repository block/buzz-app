import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./NewMessage.module.css";

export function useChipRemoval() {
  const [bursts, setBursts] = useState<{ id: number; x: number; y: number }[]>(
    [],
  );
  const sequence = useRef(0);
  useEffect(() => {
    for (let frame = 1; frame <= 5; frame++) {
      const image = new Image();
      image.src = `/recipient-removal/poof${frame}@3x.png`;
    }
  }, []);
  return {
    play(element: HTMLElement, point?: { x: number; y: number }) {
      const rect = element.getBoundingClientRect();
      setBursts((current) => [
        ...current,
        {
          id: ++sequence.current,
          x: point?.x ?? rect.left + rect.width / 2,
          y: point?.y ?? rect.top + rect.height / 2,
        },
      ]);
      try {
        const sound = new Audio("/recipient-removal/plop.m4a");
        sound.volume = 0.34;
        void sound.play().catch(() => {});
      } catch {
        /* Audio is optional; removal always succeeds. */
      }
    },
    layer: createPortal(
      <div className={styles.effects} aria-hidden="true">
        {bursts.map((burst) => (
          <span
            key={burst.id}
            className={styles.burst}
            style={{ left: burst.x, top: burst.y }}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget)
                setBursts((current) =>
                  current.filter((item) => item.id !== burst.id),
                );
            }}
          >
            {[1, 2, 3, 4, 5].map((frame) => (
              <img
                key={frame}
                className={styles.frame}
                src={`/recipient-removal/poof${frame}@3x.png`}
                alt=""
              />
            ))}
          </span>
        ))}
      </div>,
      document.body,
    ),
  };
}
