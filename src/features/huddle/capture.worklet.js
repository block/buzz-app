// A fixed 20ms/48kHz mono frame matches the existing Huddle v2 Opus sender.
class HuddleCapture extends AudioWorkletProcessor {
  frame = new Float32Array(960);
  offset = 0;

  constructor(options) {
    super();
    if (options?.processorOptions?.measureChannels) this.resetLevels(0);
  }

  resetLevels(channels) {
    this.levels = {
      channels,
      samples: 0,
      left: 0,
      right: 0,
      average: 0,
      difference: 0,
    };
  }

  measure(input) {
    const channels = input.length;
    if (this.levels.channels !== channels) this.resetLevels(channels);
    const levels = this.levels;
    const [left, right] = input;
    if (!left) return;
    for (let i = 0; i < left.length; i++) {
      const l = left[i];
      levels.left += l * l;
      if (right) {
        const r = right[i];
        const average = (l + r) / 2;
        const difference = (l - r) / 2;
        levels.right += r * r;
        levels.average += average * average;
        levels.difference += difference * difference;
      }
    }
    levels.samples += left.length;
    if (levels.samples < 12000) return;
    const db = (energy) =>
      Math.round(10 * Math.log10(Math.max(1e-12, energy / levels.samples)));
    const leftLevel = db(levels.left);
    const rightLevel = right ? db(levels.right) : -120;
    // Hold the latest speech levels through pauses so they can be read after a reply.
    if (
      channels !== this.reportedChannels ||
      Math.max(leftLevel, rightLevel) > -70
    ) {
      this.port.postMessage({
        channels,
        "channel 1 dBFS": leftLevel,
        ...(right && {
          "channel 2 dBFS": rightLevel,
          "average dBFS": db(levels.average),
          "difference dBFS": db(levels.difference),
        }),
      });
      this.reportedChannels = channels;
    }
    this.resetLevels(channels);
  }

  process(inputs) {
    if (this.levels && inputs[0]?.length) this.measure(inputs[0]);
    const input = inputs[0]?.[0];
    if (input) {
      for (const value of input) {
        this.frame[this.offset++] = Math.max(-1, Math.min(1, value));
        if (this.offset === this.frame.length) {
          this.port.postMessage(this.frame);
          this.frame = new Float32Array(960);
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("buzz-huddle-capture", HuddleCapture);
