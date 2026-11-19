import { useSyncExternalStore } from "react";

const KEY = "buzz-agent-base-prompt.v1";
const CHANGED = "buzz-agent-base-prompt-changed";

/** Device-local replacement; null uses the bundled prompt, empty removes it. */
export function basePromptPreference(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGED, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(CHANGED, listener);
    window.removeEventListener("storage", storage);
  };
}

export function useBasePromptPreference() {
  return useSyncExternalStore(subscribe, basePromptPreference, () => null);
}

/** Save before applying: a failed write leaves the active prompt unchanged. */
export function setBasePromptPreference(text: string | null): string | null {
  try {
    if (text === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, text);
    window.dispatchEvent(new Event(CHANGED));
    return null;
  } catch {
    return "The base prompt wasn’t saved. Your active prompt is unchanged. Try again.";
  }
}
