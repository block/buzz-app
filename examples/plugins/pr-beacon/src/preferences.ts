const STORAGE_KEY = "buzz-plugin.com.bostonaholic.pr-beacon.v1";

export type Preferences = {
  vipLogins: string[];
  watchedLabels: string[];
  hiddenReviewRequestUrls: string[];
  pollingEnabled: boolean;
};

const DEFAULT_PREFERENCES: Preferences = {
  vipLogins: [],
  watchedLabels: [],
  hiddenReviewRequestUrls: [],
  pollingEnabled: false,
};

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function readStoredPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw);
    return {
      vipLogins: stringArray(parsed.vipLogins),
      watchedLabels: stringArray(parsed.watchedLabels),
      hiddenReviewRequestUrls: stringArray(parsed.hiddenReviewRequestUrls),
      pollingEnabled:
        typeof parsed.pollingEnabled === "boolean"
          ? parsed.pollingEnabled
          : false,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

// Only non-secret display preferences (VIP GitHub logins, watched label
// names, hidden review-request URLs, the polling toggle) persist here. The
// GitHub token never touches storage — see tokenStore.ts.
export function createPreferencesStore() {
  let preferences = readStoredPreferences();
  // A storage write can throw (quota exceeded, private browsing, disabled
  // storage). The in-memory value still updates so the current session keeps
  // working; this exposes the failure instead of letting it become an
  // uncaught error the UI never surfaces.
  let saveError: string | null = null;
  const listeners = new Set<() => void>();
  function notify() {
    for (const listener of listeners) listener();
  }
  return {
    getPreferences: () => preferences,
    getSaveError: () => saveError,
    setPreferences: (next: Preferences) => {
      preferences = next;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        saveError = null;
      } catch (error) {
        saveError =
          error instanceof Error
            ? error.message
            : "Could not save preferences.";
      }
      notify();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type PreferencesStore = ReturnType<typeof createPreferencesStore>;
