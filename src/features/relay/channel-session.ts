import type { EventData } from "./events";

/** Shared presentation convention, never secrecy, membership or agent authority. */
export type SessionPresentation = "quiet" | "chip";
export const sessionPresentationTag = (presentation: SessionPresentation) => [
  "buzz-session",
  "1",
  presentation,
];
export const quietSessionTag = () => sessionPresentationTag("quiet");
export function sessionRootPresentation(
  event: Pick<EventData, "kind" | "tags">,
): SessionPresentation | undefined {
  const markers = event.tags.filter(([name]) => name === "buzz-session");
  const channels = event.tags.filter(([name]) => name === "h");
  const marker = markers[0];
  if (
    event.kind === 9 &&
    markers.length === 1 &&
    marker?.length === 3 &&
    marker[1] === "1" &&
    (marker[2] === "quiet" || marker[2] === "chip") &&
    channels.length === 1 &&
    channels[0]?.length === 2 &&
    channels[0]?.[1] &&
    !event.tags.some(([name]) => name === "e")
  )
    return marker[2];
  return undefined;
}
export function isQuietSessionRoot(event: Pick<EventData, "kind" | "tags">) {
  return sessionRootPresentation(event) === "quiet";
}
