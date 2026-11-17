import {
  AnimatePresence,
  motion,
  stagger,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { useEffect, useRef, useState } from "react";
import styles from "./SoloChatTitle.module.css";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ease = [0.25, 0.1, 0.25, 1] as const;
const character = {
  hidden: { opacity: 0, filter: "blur(3px)", transform: "translateX(-3px)" },
  visible: {
    opacity: 1,
    filter: "blur(0px)",
    transform: "translateX(0px)",
    transition: { duration: 0.18, ease },
  },
};

/** Key by chat id at the call site: renames animate, navigation starts at rest. */
export function SoloChatTitle({ title }: { title: string }) {
  const reducedMotion = useReducedMotion();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return (
    <span className={styles.title} data-solo-chat-title="">
      <span className="sr-only">{title}</span>
      {reducedMotion ? (
        <span className={styles.value} aria-hidden="true">
          {title}
        </span>
      ) : (
        <AnimatePresence initial={false} mode="wait">
          <TitleValue key={title} title={title} reveal={mounted.current} />
        </AnimatePresence>
      )}
    </span>
  );
}

function TitleValue({ title, reveal }: { title: string; reveal: boolean }) {
  const present = useIsPresent();
  const [revealing, setRevealing] = useState(reveal);
  const characters = revealing ? [...graphemes.segment(title)] : [];
  return (
    <motion.span
      className={styles.value}
      data-exiting={!present || undefined}
      aria-hidden="true"
      initial={reveal ? "hidden" : false}
      animate="visible"
      exit="exit"
      variants={{
        visible: {
          opacity: 1,
          filter: "blur(0px)",
          transform: "translateX(0px)",
          transition: {
            // Bound the full reveal even for long titles.
            delayChildren: stagger(
              Math.min(0.025, 0.28 / Math.max(1, characters.length - 1)),
            ),
          },
        },
        exit: {
          opacity: 0,
          filter: "blur(3px)",
          transform: "translateX(-8px)",
          transition: { duration: 0.15, ease },
        },
      }}
      onAnimationComplete={(phase) => {
        if (phase === "visible" && present) setRevealing(false);
      }}
    >
      {revealing
        ? characters.map(({ segment, index }) => (
            <motion.span
              key={index}
              className={styles.character}
              variants={character}
            >
              {segment}
            </motion.span>
          ))
        : title}
    </motion.span>
  );
}
