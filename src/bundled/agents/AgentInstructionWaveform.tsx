import { useLayoutEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";

/** Voice-note bars and sample-driven scrolling, adapted from VoiceNoteRecorder. */
export function AgentInstructionWaveform({
  levels,
}: {
  levels: readonly number[];
}) {
  const track = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  useLayoutEffect(() => {
    if (levels.length === 0 || reducedMotion || !track.current?.animate) return;
    const animation = track.current.animate(
      [{ transform: "translateX(5px)" }, { transform: "translateX(0)" }],
      { duration: 120, easing: "linear" },
    );
    return () => animation.cancel();
  }, [levels, reducedMotion]);
  return (
    <div className="agent-instruction-waveform" aria-hidden="true">
      <div ref={track} className="agent-instruction-waveform-track">
        {Array.from({ length: 40 }, (_, slot) => {
          const level = levels[levels.length - 40 + slot] ?? 0;
          const audible = Math.max(0, (Math.min(1, level) - 0.02) / 0.98);
          return (
            <span // biome-ignore lint/suspicious/noArrayIndexKey: fixed visual slots, with no item state.
              key={slot}
              style={{ height: 3 + Math.round(audible * 17) }}
            />
          );
        })}
      </div>
    </div>
  );
}
