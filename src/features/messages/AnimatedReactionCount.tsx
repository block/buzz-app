import { useEffect, useLayoutEffect, useState } from "react";
import styles from "./Messages.module.css";

export function AnimatedReactionCount({ value }: { value: number }) {
  const [motion, setMotion] = useState({ from: value, to: value, version: 0 });
  useLayoutEffect(() => {
    setMotion((current) =>
      current.to === value
        ? current
        : { from: current.to, to: value, version: current.version + 1 },
    );
  }, [value]);
  useEffect(() => {
    if (motion.from === motion.to) return;
    const timer = window.setTimeout(
      () =>
        setMotion((current) =>
          current.version === motion.version
            ? { ...current, from: current.to }
            : current,
        ),
      260,
    );
    return () => window.clearTimeout(timer);
  }, [motion]);
  return (
    <span className={styles.reactionCount}>
      <span className={styles.visuallyHidden}>{value}</span>
      <span className={styles.reactionCountMotion} aria-hidden="true">
        {motion.from === motion.to ? (
          motion.to
        ) : (
          <span
            key={motion.version}
            className={styles.reactionCountRoll}
            data-direction={motion.to > motion.from ? "up" : "down"}
          >
            <span>{motion.to > motion.from ? motion.from : motion.to}</span>
            <span>{motion.to > motion.from ? motion.to : motion.from}</span>
          </span>
        )}
      </span>
    </span>
  );
}
