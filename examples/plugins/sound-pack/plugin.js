// Self-contained external plugin: a sound pack for notification alerts.
// External plugins cannot ship separate asset files, so a real pack inlines its
// encoded audio (base64 mp3, m4a or wav) and passes it as a Blob. This example
// synthesizes short WAV tones instead, so it carries no third-party audio.
export const inject = ["notifications"];

const SAMPLE_RATE = 22050;

/** Notes play back to back: [frequency in Hz, seconds]. */
function tone(notes) {
  const samples = notes.reduce(
    (total, [, seconds]) => total + Math.round(seconds * SAMPLE_RATE),
    0,
  );
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (offset, value) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const [frequency, seconds] of notes) {
    const length = Math.round(seconds * SAMPLE_RATE);
    for (let index = 0; index < length; index++) {
      // Short attack, exponential decay: a struck tone without clicks.
      const time = index / SAMPLE_RATE;
      const envelope =
        Math.min(1, index / 64) * Math.exp((-5 * time) / seconds);
      const value = Math.sin(2 * Math.PI * frequency * time) * envelope * 0.5;
      view.setInt16(offset, Math.round(value * 32767), true);
      offset += 2;
    }
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

export function apply(ctx) {
  ctx.notifications.sounds.register({
    id: "starship",
    label: "Starship",
    sounds: [
      {
        id: "shield-recharge",
        label: "Shield Recharge",
        audio: tone([
          [440, 0.07],
          [554, 0.07],
          [659, 0.07],
          [880, 0.2],
        ]),
      },
      {
        id: "plasma-shot",
        label: "Plasma Shot",
        audio: tone([
          [1600, 0.04],
          [1200, 0.04],
          [800, 0.05],
          [500, 0.12],
        ]),
      },
      {
        id: "comms-ping",
        label: "Comms Ping",
        // A 0 Hz note is a rest.
        audio: tone([
          [1318.5, 0.08],
          [0, 0.05],
          [1318.5, 0.2],
        ]),
      },
      {
        id: "mission-complete",
        label: "Mission Complete",
        audio: tone([
          [523.3, 0.1],
          [659.3, 0.1],
          [784, 0.1],
          [1046.5, 0.4],
        ]),
      },
    ],
  });
}
