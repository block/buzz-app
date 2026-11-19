import { useEffect } from "react";
import type { EventData } from "../relay/events";
import { EXPIRED_PIN_RECOVERY, pinLists, type PinSource } from "../relay/pins";

/** Shown in place of Retry for a pin command refused as too old. It reads
 * the channel's list again, if any view keeps that list, so pins show as the
 * relay holds them. */
export function ExpiredPin({
  source,
  event,
}: {
  source: PinSource | undefined;
  event: Pick<EventData, "tags">;
}) {
  const channel = event.tags.find(([name]) => name === "h")?.[1];
  useEffect(() => {
    if (source && channel) pinLists(source).retry(channel);
  }, [source, channel]);
  return <span>{EXPIRED_PIN_RECOVERY}</span>;
}
