import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";
import { openTrace } from "./open-trace";

/** Renders shorter than this are left out of the trace. */
const MIN_RENDER_MS = 1;
const onRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  _baseDuration,
  startTime,
  commitTime,
) => {
  if (actualDuration < MIN_RENDER_MS) return;
  openTrace.record(
    "main",
    `render.${id}`,
    startTime,
    startTime + actualDuration,
    {
      phase,
      commit: Math.round(commitTime),
    },
  );
};

/** Development trace: names a subtree's React render work. React calls
 * `onRender` only in development and profiling builds. */
export function TraceProfiler({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  if (!openTrace.enabled) return children;
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
