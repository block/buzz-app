import { huddleAudio } from "./diagnostics";

export type PlayoutEvent = Readonly<
  {
    detectedAtMs: number;
    durationMs: number;
  } & (
    | { kind: "queue-limit"; queuedMs: number }
    | { kind: "underrun"; estimatedGapStartMs: number }
  )
>;

/**
 * Plays 48 kHz mono PCM frames back to back into `output`. The first frame
 * starts `lead` seconds out; after a true underrun playback re-anchors 20 ms
 * out. An incoming frame is dropped when it would start more than 200 ms
 * ahead, so a burst cannot accumulate seconds of late speech.
 */
export function createPlayout(
  context: BaseAudioContext,
  output: AudioNode,
  lead: number,
  stage?: string,
  report?: (event: PlayoutEvent) => void,
) {
  const sources = new Set<AudioBufferSourceNode>();
  let next: number | undefined;
  return {
    play(samples: readonly number[]) {
      const now = context.currentTime;
      if (!samples.length || samples.length > 5760) return;
      if (next !== undefined && next > now + 0.2) {
        report?.({
          kind: "queue-limit",
          detectedAtMs: Date.now(),
          durationMs: samples.length / 48,
          queuedMs: Math.round((next - now) * 1000),
        });
        return huddleAudio.count(stage, "dropped ahead");
      }
      if (next === undefined) next = now + lead;
      else if (next < now) {
        if (now - next < 1) {
          huddleAudio.count(stage, "underruns");
          const detectedAtMs = Date.now();
          report?.({
            kind: "underrun",
            detectedAtMs,
            estimatedGapStartMs: detectedAtMs - Math.round((now - next) * 1000),
            durationMs: Math.round((now + 0.02 - next) * 1000),
          });
        }
        next = now + 0.02;
      }
      const buffer = context.createBuffer(1, samples.length, 48000);
      buffer.copyToChannel(Float32Array.from(samples), 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(output);
      sources.add(source);
      source.onended = () => {
        sources.delete(source);
        source.disconnect();
      };
      source.start(next);
      next += buffer.duration;
    },
    close() {
      for (const source of sources) {
        source.stop();
        source.disconnect();
      }
      sources.clear();
    },
  };
}
