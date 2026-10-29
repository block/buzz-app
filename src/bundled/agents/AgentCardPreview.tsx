// The agent card about to be exported, as drawn: it tilts toward the pointer
// and a rainbow sheen follows it, as a foil card does in the hand.
import type { CSSProperties, PointerEvent } from "react";
import { FOIL_SHEEN } from "../../features/agents/share-card";
import styles from "./AgentCardPreview.module.css";

const lean = (event: PointerEvent<HTMLDivElement>) => {
  const box = event.currentTarget.getBoundingClientRect();
  const style = event.currentTarget.style;
  style.setProperty("--card-x", String((event.clientX - box.left) / box.width));
  style.setProperty("--card-y", String((event.clientY - box.top) / box.height));
};

const rest = (event: PointerEvent<HTMLDivElement>) => {
  event.currentTarget.style.removeProperty("--card-x");
  event.currentTarget.style.removeProperty("--card-y");
};

/** Without `src`, the card's place is held while it is drawn. */
export function AgentCardPreview({
  src,
  alt,
}: {
  src?: string | undefined;
  alt: string;
}) {
  return (
    <div className={styles.stage}>
      {src ? (
        <div className={styles.card} onPointerMove={lean} onPointerLeave={rest}>
          <img className={styles.image} src={src} alt={alt} draggable={false} />
          <span
            className={styles.sheen}
            style={{ "--card-sheen": FOIL_SHEEN } as CSSProperties}
            aria-hidden="true"
          />
        </div>
      ) : (
        <div className={`${styles.card} ${styles.placeholder}`} />
      )}
    </div>
  );
}
