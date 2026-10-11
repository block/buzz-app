import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const examples = [
  "Help me plan my week and prioritize tasks.",
  "Review my writing and suggest clearer wording.",
  "Research a topic and summarize the key ideas.",
  "Help me brainstorm ideas and next steps.",
];

export function InstructionExamples() {
  const [index, setIndex] = useState(0);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % examples.length),
      5000,
    );
    return () => window.clearInterval(timer);
  }, [reducedMotion]);
  return (
    <span className="agent-instruction-example text-body-sm" aria-hidden="true">
      <AnimatePresence initial={false} mode="wait">
        <motion.span
          key={index}
          initial={{ opacity: 0, y: reducedMotion ? 0 : 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reducedMotion ? 0 : -4 }}
          transition={{ duration: reducedMotion ? 0 : 0.2, ease: "easeOut" }}
        >
          {examples[index]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
