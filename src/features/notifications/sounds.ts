import type { Context } from "@deepseek-ai/cordis";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import type { NotificationCategory } from "./preferences";
import { SOUND_NAMES, type SoundRef } from "./sound";

export type SoundDefinition = Readonly<{
  /** `[a-z0-9-]{1,32}`, unique across the plugin's packs. */
  id: string;
  /** Up to 32 characters, shown in Settings. */
  label: string;
  /** Encoded audio the system webview can decode (mp3, m4a, wav, ogg). */
  audio: Blob | ArrayBuffer;
}>;
export type SoundPackDescriptor = Readonly<{
  /** `[a-z0-9-]{1,32}`, unique within the plugin. */
  id: string;
  /** Up to 32 characters; the Settings group heading. */
  label: string;
  /** 1 to 32 sounds. */
  sounds: readonly SoundDefinition[];
}>;
/** One active plugin pack, as Settings lists it. */
export type SoundPack = Readonly<{
  key: string;
  label: string;
  sounds: readonly Readonly<{ ref: SoundRef; label: string }>[];
}>;
type PackEntry = Readonly<{
  id: string;
  label: string;
  sounds: readonly Readonly<{ ref: SoundRef; label: string; source: string }>[];
}>;

const BUNDLED: ReadonlySet<string> = new Set(SOUND_NAMES);
/** Plugin ids cannot contain `_`, so these refs never collide with a pack. */
export const localSoundRef = (category: NotificationCategory): SoundRef =>
  `_local/${category}`;
export const isLocalSoundRef = (ref: SoundRef) => ref.startsWith("_local/");
const ID = /^[a-z0-9-]{1,32}$/;
// A plugin.js is capped at 8 MiB; 4 MiB of audio leaves room for its code.
const MAX_PACKS = 8;
const MAX_SOUNDS = 32;
export const MAX_SOUND_BYTES = 512 * 1024;
const MAX_PLUGIN_BYTES = 4 * 1024 * 1024;

const validLabel = (label: unknown) =>
  typeof label === "string" && label.trim() !== "" && label.length <= 32;
function audioBytes(audio: unknown) {
  if (audio instanceof Blob) return audio.size;
  if (audio instanceof ArrayBuffer) return audio.byteLength;
  throw new TypeError("Sound audio must be a Blob or ArrayBuffer");
}

/** Bundled sounds plus plugin packs: maps a SoundRef to playable media. */
export function createSoundRegistry(root: Context) {
  const packs = createContributions<PackEntry>(root);
  // Registered packs by key, including ones not yet active, for plugin limits.
  const usage = new Map<
    string,
    { pluginId: string; soundIds: readonly string[]; bytes: number }
  >();
  const elements = new Map<string, HTMLAudioElement>();
  // Pack or chosen sounds whose audio failed to load; alerts fall back to the default.
  const broken = new Set<SoundRef>();
  let indexed: readonly Contribution<PackEntry>[] | undefined;
  let catalog: readonly SoundPack[] = [];
  let sources: ReadonlyMap<string, string> = new Map();
  // Files the user chose in Settings, by ref.
  const locals = new Map<SoundRef, { label: string; source: string }>();
  let localCatalog: ReadonlyMap<SoundRef, string> = new Map();
  const localListeners = new Set<() => void>();
  const index = () => {
    const current = packs.snapshot();
    if (current === indexed) return;
    indexed = current;
    sources = new Map(
      current.flatMap((pack) =>
        pack.sounds.map((sound) => [sound.ref, sound.source] as const),
      ),
    );
    catalog = Object.freeze(
      current.map((pack) =>
        Object.freeze({
          key: pack.key,
          label: pack.label,
          sounds: Object.freeze(
            pack.sounds.map(({ ref, label }) => Object.freeze({ ref, label })),
          ),
        }),
      ),
    );
  };
  /** Media URL for a fresh element, or null for Silent and unavailable refs. */
  const source = (ref: SoundRef) => {
    if (BUNDLED.has(ref)) return `/sounds/${ref}.mp3`;
    if (broken.has(ref)) return null;
    const local = locals.get(ref);
    if (local) return local.source;
    index();
    return sources.get(ref) ?? null;
  };
  return {
    /** Active plugin packs in registration order. */
    snapshot() {
      index();
      return catalog;
    },
    /** Labels of chosen files by ref. */
    localSounds: () => localCatalog,
    subscribe(listener: () => void) {
      const stop = packs.subscribe(listener);
      localListeners.add(listener);
      return () => {
        stop();
        localListeners.delete(listener);
      };
    },
    /** Makes a chosen file playable as `localSoundRef(category)`, replacing
     * any earlier file for that row. */
    setLocal(category: NotificationCategory, label: string, audio: Blob) {
      const ref = localSoundRef(category);
      const previous = locals.get(ref);
      const source = URL.createObjectURL(audio);
      if (previous) {
        const element = elements.get(previous.source);
        if (element) element.onerror = null;
        elements.delete(previous.source);
        URL.revokeObjectURL(previous.source);
      }
      broken.delete(ref);
      locals.set(ref, { label, source });
      localCatalog = new Map(
        [...locals].map(([key, value]) => [key, value.label] as const),
      );
      for (const listener of localListeners) listener();
    },
    /** Known and playable now; Silent counts as available. */
    isAvailable: (ref: SoundRef) => ref === "silent" || source(ref) !== null,
    source,
    /** Restarts the cached element, or returns null for Silent and unavailable refs. */
    play(ref: SoundRef): HTMLAudioElement | null {
      const url = source(ref);
      if (!url) return null;
      try {
        let audio = elements.get(url);
        if (!audio) {
          audio = new Audio(url);
          if (!BUNDLED.has(ref))
            audio.onerror = () => {
              if (broken.has(ref)) return;
              broken.add(ref);
              console.warn(`Sound ${ref} could not be played`);
            };
          elements.set(url, audio);
        }
        audio.currentTime = 0;
        audio.play().catch(() => {
          // Best-effort — user may not have interacted with the page yet.
        });
        return audio;
      } catch {
        // Best-effort only.
        return null;
      }
    },
    /** Validates the whole pack before creating any media URL. Returns a
     * remover; the pack also goes when the plugin's scope ends. */
    register(ctx: Context, pack: SoundPackDescriptor): () => void {
      const pluginId = ctx.pluginOwner?.id;
      if (!pluginId)
        throw new Error(
          "Sound packs must be registered by an installed plugin",
        );
      if (
        !pack ||
        typeof pack.id !== "string" ||
        !ID.test(pack.id) ||
        !validLabel(pack.label) ||
        !Array.isArray(pack.sounds) ||
        pack.sounds.length < 1 ||
        pack.sounds.length > MAX_SOUNDS
      )
        throw new RangeError(
          "A sound pack needs an id, a label and 1 to 32 sounds",
        );
      const key = `${pluginId}/${pack.id}`;
      if (usage.has(key)) throw new RangeError(`duplicate pack id: ${pack.id}`);
      const owned = [...usage.values()].filter(
        (entry) => entry.pluginId === pluginId,
      );
      if (owned.length >= MAX_PACKS)
        throw new RangeError("A plugin may register at most 8 sound packs");
      const soundIds = new Set(owned.flatMap((entry) => entry.soundIds));
      let bytes = 0;
      for (const sound of pack.sounds) {
        if (
          !sound ||
          typeof sound.id !== "string" ||
          !ID.test(sound.id) ||
          soundIds.has(sound.id) ||
          !validLabel(sound.label)
        )
          throw new RangeError(
            `Sound ${String(sound?.id)} in pack ${pack.id} needs a unique id and a label`,
          );
        soundIds.add(sound.id);
        const size = audioBytes(sound.audio);
        if (size > MAX_SOUND_BYTES)
          throw new RangeError(`Sound ${sound.id} is larger than 512 KiB`);
        bytes += size;
      }
      if (
        owned.reduce((sum, entry) => sum + entry.bytes, bytes) >
        MAX_PLUGIN_BYTES
      )
        throw new RangeError("A plugin's sound packs may total at most 4 MiB");
      const urls: string[] = [];
      let sounds: PackEntry["sounds"] = [];
      // URLs are made inside the effect: an ended scope throws before any exist.
      const release = ctx.effect(() => {
        try {
          sounds = pack.sounds.map((sound) => {
            const url = URL.createObjectURL(
              sound.audio instanceof Blob
                ? sound.audio
                : new Blob([sound.audio]),
            );
            urls.push(url);
            return Object.freeze({
              ref: `${pluginId}/${sound.id}` as SoundRef,
              label: sound.label,
              source: url,
            });
          });
        } catch (error) {
          for (const url of urls) URL.revokeObjectURL(url);
          throw error;
        }
        usage.set(key, {
          pluginId,
          soundIds: pack.sounds.map((sound) => sound.id),
          bytes,
        });
        return () => {
          usage.delete(key);
          for (const sound of sounds) broken.delete(sound.ref);
          for (const url of urls) {
            const audio = elements.get(url);
            // A late load error must not mark a re-registered sound broken.
            if (audio) audio.onerror = null;
            elements.delete(url);
            URL.revokeObjectURL(url);
          }
        };
      }, `sounds:${key}`);
      try {
        const remove = packs.register(
          ctx,
          Object.freeze({ id: pack.id, label: pack.label, sounds }),
        );
        return () => {
          remove();
          void release();
        };
      } catch (error) {
        void release();
        throw error;
      }
    },
  };
}
