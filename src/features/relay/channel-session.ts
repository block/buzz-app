import type { EventData } from "./events";

/** Shared presentation convention, never secrecy, membership or agent authority. */
export const quietSessionTag = () => ["buzz-session", "1", "quiet"];
export function isQuietSessionRoot(
  event: Pick<EventData, "kind" | "tags">,
): boolean {
  const markers = event.tags.filter(([name]) => name === "buzz-session");
  const channels = event.tags.filter(([name]) => name === "h");
  const marker = markers[0];
  return (
    event.kind === 9 &&
    markers.length === 1 &&
    marker?.length === 3 &&
    marker[1] === "1" &&
    marker[2] === "quiet" &&
    channels.length === 1 &&
    channels[0]?.length === 2 &&
    !!channels[0]?.[1] &&
    !event.tags.some(([name]) => name === "e")
  );
}
