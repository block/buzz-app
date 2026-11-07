import type { OpenTarget } from "../navigation/targets";
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
  categories: Readonly<Record<string, boolean>>;
  quietConversations?: readonly Readonly<{
    communityOrigin: string;
    channelId: string;
  }>[];
}>;
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences =
  Object.freeze({
    enabled: true,
    notifyWhileViewing: false,
    sound: true,
    sounds: DEFAULT_CATEGORY_SOUNDS,
    categories: Object.freeze({
      mention: true,
      direct: true,
      thread: true,
      agent: true,
    }),
  });
const KEY = "buzz-notification-preferences.v1";
// Values saved before per-category sounds existed omit `sounds`; they get the
// defaults rather than failing restore and pausing alerts.
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
    if (picked === undefined) continue;
    if (!isSoundName(picked)) throw new Error("Invalid notification sounds");
    sounds[category] = picked;
  }
  return Object.freeze(sounds);
}
function parseQuietConversations(raw: unknown) {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) throw new Error("Invalid quiet conversations");
  return Object.freeze(
    raw.map((entry: unknown) => {
      if (!entry || typeof entry !== "object")
        throw new Error("Invalid quiet conversation");
      const value = entry as Record<string, unknown>;
      if (
        typeof value.communityOrigin !== "string" ||
        typeof value.channelId !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value.channelId)
      )
        throw new Error("Invalid quiet conversation");
      return Object.freeze({
        communityOrigin: relayOrigin(value.communityOrigin),
        channelId: value.channelId,
      });
    }),
  );
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
    categories: Object.freeze(Object.fromEntries(categories)),
    ...(value.quietConversations !== undefined
      ? {
          quietConversations: parseQuietConversations(value.quietConversations),
        }
      : {}),
  });
}
export function createNotificationPreferences(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
) {
  let viewer: string | undefined;
  let disposed = false;
  // Keep the old list as a fallback; new choices are independent atomic records.
  let legacyQuiet: NotificationPreferences["quietConversations"];
  const unsavedSounds = new Map<string, "silent" | "default">();
  let state = {
    preferences: DEFAULT_NOTIFICATION_PREFERENCES,
    error: null as string | null,
  };
  const listeners = new Set<() => void>();
  const key = () => `${KEY}:${viewer ?? "device"}`;
  const soundPrefix = () => `${KEY}:sound:${viewer ?? "device"}:`;
  const soundKey = (entry: { communityOrigin: string; channelId: string }) =>
    soundPrefix() + JSON.stringify([entry.communityOrigin, entry.channelId]);
  const notify = () => {
    for (const listener of listeners) listener();
  };
  function restore() {
    try {
      const raw = host?.localStorage.getItem(key());
      const preferences = raw
        ? parsePreferences(JSON.parse(raw))
        : DEFAULT_NOTIFICATION_PREFERENCES;
      legacyQuiet = preferences.quietConversations;
      const quiet = new Map(
        (legacyQuiet ?? []).map((entry) => [soundKey(entry), entry]),
      );
      const storage = host?.localStorage;
      for (let index = 0; storage && index < storage.length; index++) {
        const recordKey = storage.key(index);
        if (!recordKey?.startsWith(soundPrefix())) continue;
        const [communityOrigin, channelId] = JSON.parse(
          recordKey.slice(soundPrefix().length),
        );
        const [entry] = parseQuietConversations([
          { communityOrigin, channelId },
        ]);
        const sound = storage.getItem(recordKey);
        // A concurrent removal may occur between enumeration and reading.
        if (sound === null) continue;
        if (
          !entry ||
          soundKey(entry) !== recordKey ||
          (sound !== "silent" && sound !== "default")
        )
          throw new Error("Invalid conversation sound");
        if (sound === "silent") quiet.set(soundKey(entry), entry);
        else quiet.delete(soundKey(entry));
      }
      unsavedSounds.clear();
      state = {
        preferences: {
          ...preferences,
          quietConversations: [...quiet.values()],
        },
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
    if (
      event.key !== key() &&
      event.key !== null &&
      !event.key.startsWith(soundPrefix())
    )
      return;
    try {
      if (event.storageArea !== host?.localStorage) return;
    } catch {
      /* restore reports the failure */
    }
    // A remote change must not replace active unsaved off/silent intent.
    if (!state.error) restore();
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
      legacyQuiet = undefined;
      unsavedSounds.clear();
      restore();
    },
    update(
      patch: Partial<Omit<NotificationPreferences, "quietConversations">>,
    ) {
      if (disposed) return false;
      const preferences = parsePreferences({ ...state.preferences, ...patch });
      let error: string | null = null;
      try {
        if (!host) throw new Error("No browser storage");
        for (const [recordKey, sound] of unsavedSounds)
          host.localStorage.setItem(recordKey, sound);
        // Never save the projected list: stale Settings windows cannot erase
        // sound records written by another window.
        host.localStorage.setItem(
          key(),
          JSON.stringify({ ...preferences, quietConversations: legacyQuiet }),
        );
        unsavedSounds.clear();
      } catch {
        error =
          "These notification choices are active, but could not be saved on this device. Retry saving.";
      }
      if (error === null) {
        // Include remote choices whose events arrived while a failed save kept
        // local off intent active. Our choices are now durable too.
        restore();
      } else {
        // An off action takes effect even if persistence fails.
        state = { preferences, error };
        notify();
      }
      return state.error === null;
    },
    setConversationSound(
      entry: { communityOrigin: string; channelId: string },
      sound: "silent" | "default",
    ) {
      if (disposed) return false;
      const recordKey = soundKey(entry);
      const quiet = (state.preferences.quietConversations ?? []).filter(
        (item) => soundKey(item) !== recordKey,
      );
      if (sound === "silent") quiet.push(entry);
      let error: string | null = null;
      try {
        if (!host) throw new Error("No browser storage");
        // Independent chats never share a read-modify-write transaction.
        // Persist default too, so it overrides a legacy silent entry.
        if (host.localStorage.getItem(recordKey) !== sound)
          host.localStorage.setItem(recordKey, sound);
        if (
          state.preferences.quietConversations?.some(
            (item) => soundKey(item) === recordKey,
          ) ===
          (sound === "silent")
        )
          return true;
      } catch {
        unsavedSounds.set(recordKey, sound);
        error =
          "These notification choices are active, but could not be saved on this device. Retry saving.";
      }
      state = {
        preferences: { ...state.preferences, quietConversations: quiet },
        error,
      };
      notify();
      return error === null;
    },
    reload() {
      if (!disposed) restore();
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

/** Both desktop delivery and foreground completions use this account-local policy. */
export function isQuietConversation(
  preferences: NotificationPreferences,
  target: OpenTarget,
) {
  return (
    target.kind === "conversation" &&
    !!preferences.quietConversations?.some(
      (entry) =>
        entry.communityOrigin === target.scope.communityOrigin &&
        entry.channelId === target.channelId,
    )
  );
}
