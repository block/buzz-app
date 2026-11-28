import { huddleAudio } from "./diagnostics";

/** Serial PCM delivery shared by microphones and agent voices. Keep the newest
 * four waiting 20 ms frames (80 ms), plus one in flight. This bounds retained
 * media, not time spent waiting for IPC. Already submitted frames cannot be
 * recalled; clear() discards only those still waiting, without ending the call. */
export function createPcmSender(
  send: (samples: number[]) => Promise<void>,
  signal: AbortSignal,
  failed: (error: unknown) => void,
  stage?: string,
  dropped?: () => void,
) {
  const pending: number[][] = [];
  let sending = false;
  let broken = false;
  const clear = () => {
    pending.length = 0;
  };
  signal.addEventListener("abort", clear, { once: true });
  return {
    clear,
    async send(samples: number[]) {
      if (signal.aborted || broken) return;
      if (pending.length === 4) {
        pending.shift();
        huddleAudio.count(stage, "dropped");
        dropped?.();
      }
      pending.push(samples);
      if (sending) return;
      sending = true;
      try {
        while (!signal.aborted && pending.length) {
          const frame = pending.shift();
          if (!frame) continue;
          const start = performance.now();
          await send(frame);
          huddleAudio.took(stage, performance.now() - start, 20);
        }
      } catch (error) {
        broken = true;
        clear();
        if (!signal.aborted) failed(error);
      } finally {
        sending = false;
      }
    },
  };
}
