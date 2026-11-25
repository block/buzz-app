import { relayOrigin } from "../communities/destination";
import {
  DEFAULT_CATEGORY_SOUNDS,
  isSoundName,
  type CategorySounds,
  type SoundName,
} from "./sound";

/** Desired account-local policy is separate from system permission. */
export const NOTIFICATION_CATEGORIES = [
  "mention",
  "direct",
  "thread",
  "agent",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export type NotificationPreferences = Readonly<{
  enabled: boolean;
  notifyWhileViewing: boolean;
  sound: boolean;
  sounds: CategorySounds;
  conversationSounds: Readonly<Record<string, SoundName>>;
  categories: Readonly<Record<string, boolean>>;
}>;
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences =
  Object.freeze({
    enabled: true,
    notifyWhileViewing: false,
    sound: true,
    sounds: DEFAULT_CATEGORY_SOUNDS,
    conversationSounds: Object.freeze({}),
    categories: Object.freeze({
      mention: true,
      direct: true,
      thread: true,
      agent: true,
    }),
  });
const KEY = "buzz-notification-preferences.v1";
const ASKED_KEY = "buzz-notification-permission-asked.v1";
// Values saved before per-category sounds existed omit `sounds`; they get the
// defaults rather than failing restore and pausing alerts. So does a category
// whose saved name this build does not bundle (one chosen on a newer build).
function parseSounds(raw: unknown): CategorySounds {
  if (raw === undefined) return DEFAULT_CATEGORY_SOUNDS;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid notification sounds");
  const value = raw as Record<string, unknown>;
  const sounds: Record<NotificationCategory, SoundName> = {
    ...DEFAULT_CATEGORY_SOUNDS,
  };
  for (const category of NOTIFICATION_CATEGORIES) {
    const picked = value[category];
    if (isSoundName(picked)) sounds[category] = picked;
  }
  return Object.freeze(sounds);
}
/** Account is scoped by the preferences store; conversation IDs are community-local. */
export function conversationSoundKey(
  communityOrigin: string,
  channelId: string,
): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(channelId))
    throw new Error("Invalid notification conversation");
  return JSON.stringify([relayOrigin(communityOrigin), channelId]);
}

function parseConversationSounds(
  raw: unknown,
): Readonly<Record<string, SoundName>> {
  if (raw === undefined) return Object.freeze({});
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid conversation sounds");
  const sounds: [string, SoundName][] = [];
  for (const [key, sound] of Object.entries(raw)) {
    const parts: unknown = JSON.parse(key);
    if (
      !Array.isArray(parts) ||
      parts.length !== 2 ||
      typeof parts[0] !== "string" ||
      typeof parts[1] !== "string" ||
      conversationSoundKey(parts[0], parts[1]) !== key
    )
      throw new Error("Invalid conversation sound key");
    // As with category choices, a sound absent from this build inherits the default.
    if (isSoundName(sound)) sounds.push([key, sound]);
  }
  return Object.freeze(Object.fromEntries(sounds));
}

export function parsePreferences(raw: unknown): NotificationPreferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid notification preferences");
  const value = raw as Record<string, unknown>;
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.notifyWhileViewing !== "boolean" ||
    typeof value.sound !== "boolean" ||
    !value.categories ||
    typeof value.categories !== "object" ||
    Array.isArray(value.categories)
  )
    throw new Error("Invalid notification preferences");
  const categories = Object.entries(value.categories);
  if (
    categories.length > 128 ||
    categories.some(
      ([key, enabled]) =>
        !/^[a-z0-9][a-z0-9._/-]{0,255}$/.test(key) ||
        typeof enabled !== "boolean",
    )
  )
    throw new Error("Invalid notification categories");
  return Object.freeze({
    enabled: value.enabled,
    notifyWhileViewing: value.notifyWhileViewing,
    sound: value.sound as boolean,
    sounds: parseSounds(value.sounds),
    conversationSounds: parseConversationSounds(value.conversationSounds),
    categories: Object.freeze(Object.fromEntries(categories)),
  });
}
export function createNotificationPreferences(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
) {
  let viewer: string | undefined;
  let disposed = false;
  let state = {
    preferences: DEFAULT_NOTIFICATION_PREFERENCES,
    error: null as string | null,
  };
  const listeners = new Set<() => void>();
  const key = () => `${KEY}:${viewer ?? "device"}`;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  function restore() {
    try {
      const raw = host?.localStorage.getItem(key());
      state = {
        preferences: raw
          ? parsePreferences(JSON.parse(raw))
          : DEFAULT_NOTIFICATION_PREFERENCES,
        error: null,
      };
    } catch {
      // Never turn alerts on because stored off intent could not be read.
      state = {
        preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: false },
        error:
          "Notification preferences could not be restored. Alerts are paused; retry loading your settings.",
      };
    }
    notify();
  }
  const changed = (event: StorageEvent) => {
    if (event.key !== key() && event.key !== null) return;
    try {
      if (event.storageArea !== host?.localStorage) return;
    } catch {
      /* restore reports the failure */
    }
    restore();
  };
  restore();
  host?.addEventListener("storage", changed);
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    selectViewer(next: string | undefined) {
      if (disposed || next === viewer) return;
      if (next !== undefined && !/^[a-f0-9]{64}$/.test(next))
        throw new Error("Invalid notification viewer");
      viewer = next;
      restore();
    },
    update(patch: Partial<NotificationPreferences>) {
      if (disposed) return false;
      const preferences = parsePreferences({ ...state.preferences, ...patch });
      let error: string | null = null;
      try {
        if (!host) throw new Error("No browser storage");
        host.localStorage.setItem(key(), JSON.stringify(preferences));
      } catch {
        error =
          "These notification choices are active, but could not be saved on this device. Retry saving.";
      }
      // An off action takes effect even if persistence fails. Permission completion never changes it.
      state = { preferences, error };
      notify();
      return error === null;
    },
    reload() {
      if (!disposed) restore();
    },
    /** True once per device, for every account: records the automatic system
     * permission request before it is sent. Storage that cannot be read or
     * written counts as already asked, so the prompt never repeats. */
    claimAutomaticRequest() {
      try {
        if (disposed || !host || host.localStorage.getItem(ASKED_KEY) !== null)
          return false;
        host.localStorage.setItem(ASKED_KEY, "1");
        return true;
      } catch {
        return false;
      }
    },
    dispose() {
      disposed = true;
      host?.removeEventListener("storage", changed);
      listeners.clear();
    },
  };
}
export type NotificationPreferencesService = ReturnType<
  typeof createNotificationPreferences
>;
