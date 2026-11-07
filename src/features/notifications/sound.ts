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

/** A bundled name, Silent, or `<pluginId>/<soundId>` for a plugin sound. */
export type SoundRef = SoundName | `${string}/${string}`;
const PLUGIN_SOUND_REF = /^[A-Za-z0-9_.-]{1,128}\/[a-z0-9-]{1,32}$/;
/** Shape only: whether a plugin sound is installed is decided at play time,
 * so removing a pack never invalidates saved preferences. */
export function isSoundRef(value: unknown): value is SoundRef {
  return (
    isSoundName(value) ||
    (typeof value === "string" && PLUGIN_SOUND_REF.test(value))
  );
}

export type CategorySounds = Readonly<Record<NotificationCategory, SoundRef>>;
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
): SoundRef {
  return (
    (sounds as Partial<Record<string, SoundRef>>)[category] ?? DEFAULT_SOUND
  );
}
