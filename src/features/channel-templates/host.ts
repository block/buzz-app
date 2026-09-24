import type { RelayEvent } from "../relay/events";
import type { KitRecord } from "./model";
export interface ChannelKitHost {
  prepare(record: KitRecord, signal: AbortSignal): Promise<string>;
  decode(
    events: readonly RelayEvent[],
    signal: AbortSignal,
  ): Promise<{ eventId: string; record: KitRecord }[]>;
}
