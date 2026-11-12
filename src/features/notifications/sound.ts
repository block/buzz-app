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

// Web Audio, not an <audio> element: WebKit makes a played media element the
// macOS Now Playing session, so the keyboard play/pause key would replay the
// last alert instead of controlling the user's music. An AudioContext only
// becomes Now Playing when navigator.audioSession.type is "playback".
let output: AudioContext | undefined;
let playing = 0;
const clips = new Map<SoundName, Promise<AudioBuffer>>();

function loadClip(
  context: AudioContext,
  name: SoundName,
): Promise<AudioBuffer> {
  let clip = clips.get(name);
  if (!clip) {
    clip = fetch(`/sounds/${name}.mp3`)
      .then((response) => {
        if (!response.ok) throw new Error(`Sound ${name}: ${response.status}`);
        return response.arrayBuffer();
      })
      .then((data) => context.decodeAudioData(data));
    clips.set(name, clip);
    // A failed load may succeed later; never cache the rejection.
    clip.catch(() => clips.delete(name));
  }
  return clip;
}

/**
 * Play a bundled sound; best-effort. `ended` runs once when it finishes or
 * fails to load, unless the returned function stopped it first.
 */
export function playNotificationSound(
  name: SoundName,
  ended?: () => void,
): () => void {
  const none = () => {};
  if (name === "silent") return none;
  try {
    if (!output || output.state === "closed") output = new AudioContext();
    const context = output;
    const ready = Promise.all([loadClip(context, name), context.resume()]);
    playing += 1;
    let stopped = false;
    let finished = false;
    let source: AudioBufferSourceNode | undefined;
    // Release the output device once no sound is loading or playing.
    const done = () => {
      if (finished) return;
      finished = true;
      if (--playing === 0) void context.suspend().catch(() => {});
      if (!stopped) ended?.();
    };
    void ready
      .then(([buffer]) => {
        if (stopped) return done();
        const node = context.createBufferSource();
        source = node;
        node.buffer = buffer;
        node.connect(context.destination);
        node.onended = () => {
          try {
            node.disconnect();
          } finally {
            done();
          }
        };
        node.start();
      })
      // Best-effort — user may not have interacted with the page yet.
      .catch(done);
    return () => {
      if (stopped) return;
      stopped = true;
      try {
        // Ending the source runs `done` through `onended`.
        source?.stop();
      } catch {
        done();
      }
    };
  } catch {
    // Best-effort only.
    return none;
  }
}
