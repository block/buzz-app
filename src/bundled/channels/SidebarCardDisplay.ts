import { createContext, useSyncExternalStore } from "react";
import { readView, subscribeView, writeView } from "../../shared/view-state";

/** How a card draws its rows: a list of names, or a wrap of identity tiles. */
export type SidebarCardDisplay = "list" | "icons";

const displayKey = "sidebar:card-display";

/** The display of the card around a row; rows outside a card are a list. */
export const SidebarCardDisplayContext =
  createContext<SidebarCardDisplay>("list");

function savedDisplays(scope: string): Record<string, "icons"> {
  const saved = readView<unknown>(scope, displayKey, {});
  return saved && typeof saved === "object" && !Array.isArray(saved)
    ? Object.fromEntries(
        Object.entries(saved).filter(
          (entry): entry is [string, "icons"] => entry[1] === "icons",
        ),
      )
    : {};
}

/**
 * A card's display, remembered on this device like its height. Without a
 * scope the card has no saved state and stays a list.
 */
export function useSidebarCardDisplay(scope: string | undefined, card: string) {
  const display = useSyncExternalStore<SidebarCardDisplay>(
    (change) => (scope ? subscribeView(scope, change) : () => {}),
    () => (scope && savedDisplays(scope)[card]) || "list",
  );
  const change = (next: SidebarCardDisplay) => {
    if (!scope) return;
    const { [card]: _, ...rest } = savedDisplays(scope);
    writeView(
      scope,
      displayKey,
      next === "icons" ? { ...rest, [card]: next } : rest,
    );
  };
  return [display, change] as const;
}
