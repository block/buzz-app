import type { NotificationCategory } from "./preferences";

/** Bundled alert sounds under public/sounds, shared with the reference client. */
export const SOUND_NAMES = [
  "bong",
  "boo",
  "dng",
  "doo",
  "doodone",
  "doong",
  "doop",
  "flirl",
  "flutter",
  "oh-no",
  "ping",
  "soft",
  "unison",
] as const;
export type SoundName = (typeof SOUND_NAMES)[number] | "silent";
const SOUND_NAME_SET: ReadonlySet<string> = new Set(SOUND_NAMES);
export function isSoundName(value: unknown): value is SoundName {
  return (
    value === "silent" ||
    (typeof value === "string" && SOUND_NAME_SET.has(value))
  );
}

export const DEFAULT_SOUND: SoundName = "flutter";

export type CategorySounds = Readonly<Record<NotificationCategory, SoundName>>;
export const DEFAULT_CATEGORY_SOUNDS: CategorySounds = Object.freeze({
  mention: DEFAULT_SOUND,
  direct: DEFAULT_SOUND,
  thread: DEFAULT_SOUND,
  agent: DEFAULT_SOUND,
});

/** Row copy and recommendations reuse the reference client's event rows. */
export const CATEGORY_SOUND_LABELS: Record<NotificationCategory, string> = {
  direct: "Direct messages",
  mention: "@Mentions",
  thread: "Thread replies",
  agent: "Solo chat completions",
};
export const RECOMMENDED_SOUND_BY_CATEGORY: Record<
  NotificationCategory,
  SoundName
> = {
  direct: "unison",
  mention: "ping",
  thread: "doop",
  agent: "doodone",
};

/** Plugin categories have no per-category choice; they use the default sound. */
export function resolveCategorySound(
  sounds: CategorySounds,
  category: string,
): SoundName {
  return (
    (sounds as Partial<Record<string, SoundName>>)[category] ?? DEFAULT_SOUND
  );
}

/** A short sound effect, without registering an HTML media element. */
export type SoundPlayback = { stop(): void; finished: Promise<void> };

let context: AudioContext | undefined;
const buffers = new Map<SoundName, Promise<AudioBuffer>>();
const playing = new Map<SoundName, SoundPlayback>();

export function playSoundEffect(name: SoundName): SoundPlayback | null {
  if (name === "silent") return null;
  try {
    if (!context || context.state === "closed") {
      context = new AudioContext();
      buffers.clear();
    }
    const audio = context;
    // Resume inside the initiating gesture, before fetching/decoding the clip.
    const ready =
      audio.state === "running" ? Promise.resolve() : audio.resume();
    let source: AudioBufferSourceNode | undefined;
    let stopped = false;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (source) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // A source whose start failed has nothing left to stop.
        } finally {
          source.disconnect();
          finish();
        }
      }
      finish();
    };
    let buffer = buffers.get(name);
    if (!buffer) {
      buffer = fetch(`/sounds/${name}.mp3`).then(async (response) => {
        if (!response.ok) throw new Error("Notification sound unavailable");
        return audio.decodeAudioData(await response.arrayBuffer());
      });
      buffers.set(name, buffer);
      const loading = buffer;
      void buffer.catch(() => {
        if (buffers.get(name) === loading) buffers.delete(name);
      });
    }
    void Promise.all([ready, buffer])
      .then(([, decoded]) => {
        if (stopped) return;
        source = audio.createBufferSource();
        source.buffer = decoded;
        source.connect(audio.destination);
        source.onended = () => {
          source?.disconnect();
          source = undefined;
          stopped = true;
          finish();
        };
        source.start();
      })
      .catch(stop);
    return { stop, finished };
  } catch {
    // Best-effort only (including hosts without Web Audio).
    return null;
  }
}

export function playNotificationSound(name: SoundName): SoundPlayback | null {
  playing.get(name)?.stop();
  const playback = playSoundEffect(name);
  if (playback) {
    playing.set(name, playback);
    void playback.finished.then(() => {
      if (playing.get(name) === playback) playing.delete(name);
    });
  }
  return playback;
}
