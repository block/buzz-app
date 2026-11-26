// Two 60 Hz frames plus scheduling tolerance: a gap above this missed a frame.
const TWO_FRAMES_MS = (2 * 1000) / 60 + 1;

// Intervals between animation-frame callbacks during a gesture. Clip boundary
// gaps, but retain every callback inside the gesture, including stalls while
// the scroll offset is unchanged. No callbacks means one gap.
export function gestureGaps(times, gestureStartMs, gestureEndMs) {
  if (
    !Number.isFinite(gestureStartMs) ||
    !Number.isFinite(gestureEndMs) ||
    gestureEndMs <= gestureStartMs
  )
    throw new Error("Missing or invalid scroll gesture timestamps");
  const inside = [
    gestureStartMs,
    ...times.filter((t) => t > gestureStartMs && t < gestureEndMs),
    gestureEndMs,
  ];
  return inside.slice(1).map((t, i) => t - inside[i]);
}

export function scrollCadence({ frames, gestureStartMs, gestureEndMs }) {
  const gaps = gestureGaps(
    frames.map(({ t }) => t),
    gestureStartMs,
    gestureEndMs,
  );
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    rafMaxGapMs: Math.max(...gaps),
    rafP95GapMs: sorted[Math.ceil(sorted.length * 0.95) - 1],
    rafGapsOver33: gaps.filter((gap) => gap > TWO_FRAMES_MS).length,
    rafGapsOver50: gaps.filter((gap) => gap > 50).length,
  };
}

// Time and distinct waits spent pinned at the top edge (scrollTop <= 1) during
// a scroll gesture, waiting for older pages to arrive.
export function topEdgeWait({ frames, gestureStartMs, gestureEndMs }) {
  if (
    !Number.isFinite(gestureStartMs) ||
    !Number.isFinite(gestureEndMs) ||
    gestureEndMs <= gestureStartMs
  )
    throw new Error("Missing or invalid scroll gesture timestamps");
  let edgeWaitMs = 0;
  let edgeHits = 0;
  let spanStart = null;
  const edgeSpansMs = [];
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const curr = frames[i];
    if (prev.t < gestureStartMs || curr.t > gestureEndMs) continue;
    if (prev.top !== null && prev.top <= 1) {
      edgeWaitMs += curr.t - prev.t;
      if (spanStart === null) {
        spanStart = prev.t;
        edgeHits++;
      }
    } else if (spanStart !== null) {
      edgeSpansMs.push(prev.t - spanStart);
      spanStart = null;
    }
  }
  if (spanStart !== null) {
    const lastIn = frames.findLast(({ t }) => t <= gestureEndMs);
    if (lastIn && lastIn.t > spanStart) edgeSpansMs.push(lastIn.t - spanStart);
  }
  return {
    edgeWaitMs,
    edgeHits,
    maxEdgeSpanMs: edgeSpansMs.length ? Math.max(...edgeSpansMs) : 0,
    edgeSpansMs,
  };
}
