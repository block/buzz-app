import { createContext } from "react";
import type { Navigation } from "../navigation/controller";
import { targetKey, type OpenTarget } from "../navigation/targets";

/** Where an opening began: the pane of the tab or panel its link was chosen
 * in. The origin belongs to the opening, not to the address, so it is kept
 * here beside the navigator and read by the page that applies the visit. */

// The visit each navigator last opened from the side pane. A visit's id is
// never reused, so one left here places no other visit.
const sideVisits = new WeakMap<Navigation, string>();
// The attempt a link began by naming the visit already on screen.
const repeats = new WeakMap<Navigation, string>();

type Conversation = Extract<OpenTarget, { kind: "conversation" }>;

const sameConversation = (visit: OpenTarget, current: Conversation) =>
  visit.kind === "conversation" &&
  visit.channelId === current.channelId &&
  visit.scope.viewer === current.scope.viewer &&
  visit.scope.communityOrigin === current.scope.communityOrigin;

/** How `target` stands to the thread read inline over `current`: a thread
 * of that conversation that opens as a tab beside it, that thread itself, or
 * neither. */
function toInline(
  current: OpenTarget | undefined,
  target: OpenTarget,
): "beside" | "sheet" | undefined {
  if (
    current?.kind !== "conversation" ||
    !current.inline ||
    target.kind !== "conversation" ||
    !sameConversation(target, current) ||
    !target.messageId ||
    target.inline ||
    target.detail ||
    target.panel ||
    target.forward ||
    target.layer ||
    target.context
  )
    return;
  return (target.threadRootId ?? target.messageId) === current.inline
    ? "sheet"
    : "beside";
}

/** A thread's tab opened beside `current`: the visit `target` asks for,
 * with the thread read inline over that conversation still in it, so the
 * sheet stays as the tab opens. A target that names the inline thread is
 * left alone: that thread is leaving for its tab. */
export function besideInline(
  current: OpenTarget | undefined,
  target: OpenTarget,
): OpenTarget {
  if (
    current?.kind !== "conversation" ||
    !current.inline ||
    target.kind !== "conversation" ||
    toInline(current, target) !== "beside"
  )
    return target;
  return {
    ...target,
    inline: current.inline,
    ...(current.inlineMessage ? { inlineMessage: current.inlineMessage } : {}),
  };
}

/** The visits that leave with the thread `rootId` read inline over
 * `current`'s conversation: the ones that read it there and name no message
 * of their own, and `current`, the visit on screen. A tab's visit that kept
 * the sheet beside it stays, so Back still reaches that tab. */
export const sheetVisits =
  (current: Conversation, rootId: string) => (visit: OpenTarget) =>
    sameConversation(visit, current) &&
    visit.kind === "conversation" &&
    visit.inline === rootId &&
    (!visit.messageId || targetKey(visit) === targetKey(current));

/** Opens `target` for a link chosen in a tab or panel of `pane`. A visit
 * opened from the side pane is remembered, so the page that applies it knows
 * where it began, and keeps the thread read inline over its conversation:
 * the main view does not react to the side pane. */
export function openFromTab(
  navigator: Navigation,
  target: OpenTarget,
  pane: "main" | "side" | undefined,
) {
  const shown = navigator.snapshot().entry;
  // The thread read inline, chosen in the side pane, is handed to its tab as
  // Move to side panel hands it: the sheet's visits retire and the tab's
  // takes their place, so Back and reload do not bring the sheet back.
  if (
    pane === "side" &&
    shown.target.kind === "conversation" &&
    shown.target.inline &&
    toInline(shown.target, target) === "sheet"
  ) {
    const visits = sheetVisits(shown.target, shown.target.inline);
    navigator.dismiss((visit, id) => id === shown.id || visits(visit), target);
    const { entry } = navigator.snapshot();
    if (targetKey(entry.target) === targetKey(target))
      sideVisits.set(navigator, entry.id);
    return;
  }
  const opening = pane === "side" ? besideInline(shown.target, target) : target;
  void navigator.open(opening);
  // The attempt is the opening's unless something held it, as a prompt to
  // keep unsaved work does; that visit then opens as any other.
  const { entry, id } = navigator.snapshot().attempt;
  if (targetKey(entry.target) !== targetKey(opening)) return;
  if (pane === "side") sideVisits.set(navigator, entry.id);
  if (entry.id === shown.id) repeats.set(navigator, id);
}

/** Whether visit `entryId` was opened from the side pane. */
export const openedFromSide = (
  navigator: Navigation | undefined,
  entryId: string,
) => !!navigator && sideVisits.get(navigator) === entryId;

/** The attempt on screen, when a link began it by naming the visit already
 * there. The navigator restarts that visit and a page applies a visit once,
 * so this is how the page learns the link asked for its thread again. */
export function repeatedOpening(navigator: Navigation | undefined) {
  const id = navigator?.snapshot().attempt.id;
  return navigator && id && repeats.get(navigator) === id ? id : undefined;
}

/** The pane a panel is shown in: a panel tab's, or the side pane for the
 * panel a channel launcher opens there. Unset anywhere else. */
export const PanelPane = createContext<"main" | "side" | undefined>(undefined);

/** Opens `target` for a link in a panel shown in `pane`. In a pane, it
 * opens as a link in a thread tab of that pane does; anywhere else, as any
 * opening. */
export function openFromPanel(
  navigator: Navigation,
  target: OpenTarget,
  pane: "main" | "side" | undefined,
) {
  if (pane) openFromTab(navigator, target, pane);
  else void navigator.open(target);
}
