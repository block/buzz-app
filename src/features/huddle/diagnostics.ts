import { developerMode } from "../developer/mode";

/** Where an agent's decoded Codex voice plays: sent through the relay as
 * usual, or straight to this device's speaker, bypassing the relay. */
export type AgentPlayback = "relay" | "local";
export type AudioReport = Record<string, Record<string, number>>;

export type VoiceDiagnostic = Readonly<
  { detectedAtMs: number } & (
    | {
        kind: "codex-webrtc";
        fromMs: number;
        packetsLost: number;
        concealmentEvents: number;
        concealedMs: number;
      }
    | { kind: "codex-decoded-gap"; durationMs: number }
    | { kind: "agent-send-drop" }
    | { kind: "native-relay"; packetsSkipped: number; jitterRejected: number }
  )
>;

const stages = new Map<string, Record<string, number>>();
const arrivals = new Map<string, number>();
const listeners = new Set<() => void>();
let playback: AgentPlayback = "relay";

function bump(stage: string, counter: string, value: number, peak = false) {
  const counters = stages.get(stage) ?? {};
  stages.set(stage, counters);
  counters[counter] = peak
    ? Math.max(counters[counter] ?? 0, value)
    : (counters[counter] ?? 0) + value;
}

/** Development only: counts Huddle audio frames, gaps and drops at each hop,
 * and switches agent playback. Keeps counts and timings, never audio. Every
 * call without a stage, or outside development, does nothing. */
export const huddleAudio = {
  enabled: developerMode,
  /** A frame arrived. A gap over `budget` ms is late; one over a second is a
   * pause, not a dropout. */
  frame(stage: string | undefined, budget: number) {
    if (!developerMode || !stage) return;
    const now = performance.now();
    const gap = now - (arrivals.get(stage) ?? now);
    arrivals.set(stage, now);
    bump(stage, "frames", 1);
    if (gap > 1000) return bump(stage, "pauses", 1);
    if (gap > budget) bump(stage, "late", 1);
    bump(stage, "max gap ms", Math.round(gap), true);
  },
  /** An operation took `ms`; over `budget` ms is slow. */
  took(stage: string | undefined, ms: number, budget: number) {
    if (!developerMode || !stage) return;
    bump(stage, "calls", 1);
    if (ms > budget) bump(stage, "slow", 1);
    bump(stage, "max ms", Math.round(ms), true);
  },
  count(stage: string | undefined, counter: string, value = 1) {
    if (developerMode && stage && value) bump(stage, counter, value);
  },
  measure(stage: string, values: Record<string, number>) {
    if (developerMode) stages.set(stage, values);
  },
  report: (): AudioReport =>
    Object.fromEntries([...stages].map(([key, value]) => [key, { ...value }])),
  reset() {
    stages.clear();
    arrivals.clear();
  },
  playback: () => playback,
  setPlayback(next: AgentPlayback) {
    if (!developerMode || next === playback) return;
    playback = next;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
