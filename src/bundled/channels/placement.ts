import { threadPlacementPreference } from "../../features/messages/thread-preferences";
import type { MediaReviewOrigin } from "../../features/messages/composer-overlay";
import type { Panel } from "../../features/panels/service";

/** What the viewer opened from a view: a thread, a panel (a profile, a pull
 * request, a diff, a plugin's link panel), media, or a link to a Solo chat. */
export type Opening =
  | Readonly<{ kind: "thread" }>
  | Readonly<{ kind: "media" }>
  | Readonly<{ kind: "panel"; panel: Pick<Panel, "inline"> }>
  | Readonly<{ kind: "chat" }>;

/**
 * Where an opening goes: `inline` is a dialog on the view it was opened from
 * (for a Solo chat link, going to the chat itself, since inline opens no
 * tabs); `tab` is a tab, as on main, or for media its fullscreen viewer.
 * Media is a viewer either way: it never adds a step to history.
 *
 * This is the only place that reads the placement setting for an opening.
 * Under any setting but inline everything opens as a tab. Under inline, an
 * opening that already has a tab focuses that tab, so nothing is inline and
 * in a tab at once; a view that can't hold a dialog, and a panel that
 * declares `inline: false`, open tabs too.
 */
export function placeOpening(
  opening: Opening,
  {
    hasTab,
    canHold,
  }: Readonly<{
    /** A tab already shows it. */
    hasTab: boolean;
    /** The page addresses dialogs on the view it was opened from. */
    canHold: boolean;
  }>,
): "inline" | "tab" {
  if (threadPlacementPreference() !== "inline") return "tab";
  if (hasTab || !canHold) return "tab";
  if (opening.kind === "panel" && opening.panel.inline === false) return "tab";
  return "inline";
}

/** Whether media opened from a view reads in a sheet over it. */
export const inlineMedia = (opening: MediaReviewOrigin | undefined) =>
  placeOpening({ kind: "media" }, { hasTab: false, canHold: !!opening }) ===
  "inline";
