import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  parseOpenTarget,
  type OpenTarget,
} from "../../features/navigation/targets";
import {
  readView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";

export type RailEntry = {
  id: string;
  label: string;
  kind: "person" | "agent" | "channel" | "chat" | "page";
  picture?: string | undefined;
  target: OpenTarget | { kind: "person"; pubkey: string };
};
const KEY = "navigation-pins:v1";
const kinds = new Set(["person", "agent", "channel", "chat", "page"]);

/** Pins are local view intent, scoped by account and community like drafts. */
export function readRailPins(scope: string): RailEntry[] {
  return parseRailEntries(readView<unknown>(scope, KEY, []));
}

export function parseRailEntries(value: unknown): RailEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: RailEntry[] = [];
  for (const row of value) {
    if (
      !row ||
      typeof row.id !== "string" ||
      typeof row.label !== "string" ||
      !kinds.has(row.kind)
    )
      continue;
    try {
      const target =
        row.target?.kind === "person" &&
        /^[a-f0-9]{64}$/.test(row.target.pubkey)
          ? { kind: "person" as const, pubkey: row.target.pubkey }
          : parseOpenTarget(row.target);
      if (entries.some((entry) => entry.id === row.id)) continue;
      entries.push({
        id: row.id,
        label: row.label.slice(0, 256),
        kind: row.kind,
        ...(typeof row.picture === "string" ? { picture: row.picture } : {}),
        target,
      });
    } catch {
      /* An obsolete or malformed destination does not break navigation. */
    }
  }
  return entries;
}

export function useRailPins(scope: string) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeView(scope, listener),
    [scope],
  );
  const revision = useSyncExternalStore(
    subscribe,
    () => viewRevision(scope, KEY),
    () => undefined,
  );
  const pins = useMemo(
    () => (revision !== undefined ? readRailPins(scope) : []),
    [scope, revision],
  );
  const setPinned = (entry: RailEntry, pinned: boolean) => {
    const current = readRailPins(scope).filter((pin) => pin.id !== entry.id);
    return writeView(scope, KEY, pinned ? [...current, entry] : current);
  };
  return { pins, setPinned };
}
