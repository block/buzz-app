import { useSyncExternalStore } from "react";
import {
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";

// Pinned plugins are kept on this device, like whether each plugin is on, so
// one choice applies in every community. Undefined means the person never
// chose, and the built-in pages stand in as pins.
const SCOPE = "shell";
const KEY = "plugin-pins";
const MAX_PINS = 256;

function parse(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  return [...new Set(ids)].slice(0, MAX_PINS);
}

// The parsed list is cached by its stored text, so snapshots are stable.
let cached: { text: string | null; pins: readonly string[] | undefined } = {
  text: null,
  pins: undefined,
};
export function savedPluginPins(): readonly string[] | undefined {
  const text = viewRevision(SCOPE, KEY);
  if (text === undefined || text === cached.text) return cached.pins;
  let value: unknown = null;
  try {
    value = JSON.parse(text ?? "null");
  } catch {}
  cached = { text, pins: parse(value) };
  return cached.pins;
}

export function savePluginPins(ids: readonly string[]) {
  writeView(SCOPE, KEY, [...new Set(ids)].slice(0, MAX_PINS));
}

const subscribe = (listener: () => void) => subscribeView(SCOPE, listener, KEY);

export function useSavedPluginPins() {
  return useSyncExternalStore(subscribe, savedPluginPins, savedPluginPins);
}

/** How pinned plugins are ordered: A–Z until the person moves one, then in
 * their own order until they choose A–Z again. */
export type PluginPinSort = "alphabetical" | "custom";
const SORT_KEY = "plugin-pin-sort";

export function savedPluginPinSort(): PluginPinSort {
  return viewRevision(SCOPE, SORT_KEY) === JSON.stringify("custom")
    ? "custom"
    : "alphabetical";
}

export function savePluginPinSort(sort: PluginPinSort) {
  writeView(SCOPE, SORT_KEY, sort);
}

const subscribeSort = (listener: () => void) =>
  subscribeView(SCOPE, listener, SORT_KEY);

export function useSavedPluginPinSort() {
  return useSyncExternalStore(
    subscribeSort,
    savedPluginPinSort,
    savedPluginPinSort,
  );
}
