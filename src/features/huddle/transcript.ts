const sampleRate = 48_000;
const preRoll = sampleRate / 5;
const trailingSilence = sampleRate * 0.65;
const maxUtterance = sampleRate * 19;

export function createMicrophoneTranscript(
  signal: AbortSignal,
  publish: (text: string) => void,
  report: (error: unknown) => void,
  recognize: (samples: number[]) => Promise<string>,
) {
  let frames: number[][] = [];
  let length = 0;
  let voiced = 0;
  let silence = 0;
  let pending = 0;
  let queue = Promise.resolve();
  function flush() {
    const utterance = frames;
    const shouldRecognize = voiced >= sampleRate * 0.12;
    frames = [];
    length = voiced = silence = 0;
    if (!shouldRecognize || signal.aborted) return queue;
    if (pending >= 3) {
      report(
        new Error("Speech recognition fell behind. A transcript was skipped."),
      );
      return queue;
    }
    pending++;
    queue = queue
      .then(async () => {
        if (signal.aborted) return;
        // Capture is 48 kHz mono. Average triples to reduce aliasing at 16 kHz.
        const samples = utterance.flatMap((frame) =>
          Array.from({ length: Math.floor(frame.length / 3) }, (_, index) => {
            const i = index * 3;
            const mean =
              ((frame[i] ?? 0) + (frame[i + 1] ?? 0) + (frame[i + 2] ?? 0)) / 3;
            return Math.round(Math.max(-1, Math.min(1, mean)) * 32767);
          }),
        );
        const text = (await recognize(samples)).trim();
        if (text && !signal.aborted) publish(text);
      })
      .catch((error: unknown) => {
        if (!signal.aborted) report(error);
      })
      .finally(() => {
        pending--;
      });
    return queue;
  }
  return {
    input(frame: number[]) {
      if (signal.aborted || !frame.length) return;
      const loud =
        frame.reduce((energy, sample) => energy + sample * sample, 0) >
        frame.length * 0.009 ** 2;
      frames.push(frame);
      length += frame.length;
      if (loud) {
        voiced += frame.length;
        silence = 0;
      } else if (voiced) {
        silence += frame.length;
      } else {
        while (length > preRoll && frames.length)
          length -= frames.shift()?.length ?? 0;
      }
      if (silence >= trailingSilence || length >= maxUtterance) flush();
    },
    flush,
  };
}
