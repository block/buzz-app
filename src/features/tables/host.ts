import type { RelayEvent } from "../relay/events";

/** Seals the owner's key for the table at `head` to `member`, from one of
 * the owner's `grants` for it. The key never reaches the webview. */
export interface TableKeyHost {
  reseal(
    head: RelayEvent,
    grants: readonly RelayEvent[],
    member: string,
    signal: AbortSignal,
  ): Promise<string>;
}
