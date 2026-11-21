import { isTauri } from "@tauri-apps/api/core";
import type { KeyBinding } from "../../features/shortcuts/bindings";
import { isApplePlatform } from "../../features/shortcuts/format";

export const GO_TO_DOCK = "go-to-dock";
/** D for Dock: free in the app, the composer and the native menus. */
export const GO_TO_DOCK_BINDING: KeyBinding = Object.freeze({
  key: "d",
  mod: true,
});
/** The macOS Window → Go to Dock item sends this, with the focused guest. */
export const GO_TO_DOCK_EVENT = "buzz:go-to-dock";

/** macOS desktop: the native menu owns ⌘D, so it also works over a guest
 * page. Elsewhere the web shortcut owns it. */
export function nativeDockMenu(
  desktop = isTauri(),
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
) {
  return desktop && isApplePlatform(platform);
}

/** Chords the dispatcher leaves to the native menu on this platform. */
export function nativeShortcutChords(
  desktop?: boolean,
  platform?: string,
): readonly KeyBinding[] {
  return nativeDockMenu(desktop, platform) ? [GO_TO_DOCK_BINDING] : [];
}
