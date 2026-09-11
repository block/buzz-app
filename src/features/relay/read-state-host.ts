import type { RelayEvent } from "./events";
import type { ReadBlob } from "./read-state-model";

export type ReadStateSigning = Readonly<{
  slot: string;
  createdAt: number;
  blob: ReadBlob;
}>;
export type DecodedReadState = Readonly<{ eventId: string; blob: unknown }>;
/** Private host boundary: no generic NIP-44 or arbitrary-kind signing reaches plugins. */
export interface ReadStateHost {
  decode(
    events: readonly RelayEvent[],
    signal: AbortSignal,
  ): Promise<readonly DecodedReadState[]>;
  sign?(intent: ReadStateSigning, signal: AbortSignal): Promise<RelayEvent>;
  publish?(event: RelayEvent, signal: AbortSignal): Promise<void>;
  /** Advertised independently through host-bound NIP-11, not echoed from the request. */
  readonly communityId?: string;
}
export const READ_SNAPSHOT_EVENTS = 4096;
export const READ_SNAPSHOT_BYTES = 8 * 1024 * 1024;
