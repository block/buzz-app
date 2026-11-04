// The owner's choices, on this device. Anything unreadable falls back to the narrowest default.
import { DEFAULT_SETTINGS, type Settings } from "./types.ts";

export const KEY = "buzz-recall.settings.v1";

export function load(): Settings {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const s = (saved && typeof saved === "object" ? saved : {}) as Record<
      string,
      unknown
    >;
    return {
      scope: s.scope === "relay" ? "relay" : "channel",
      sharedMemories: s.sharedMemories === true,
      ...(typeof s.embeddingUrl === "string"
        ? { embeddingUrl: s.embeddingUrl }
        : {}),
      ...(typeof s.embeddingKey === "string"
        ? { embeddingKey: s.embeddingKey }
        : {}),
      ...(typeof s.queryPrefix === "string"
        ? { queryPrefix: s.queryPrefix }
        : {}),
      ...(typeof s.documentPrefix === "string"
        ? { documentPrefix: s.documentPrefix }
        : {}),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function save(settings: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
}
