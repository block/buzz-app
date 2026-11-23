import { openTrace } from "../developer/open-trace";
import { readErrorKind } from "./errors";

/**
 * TEMPORARY: a first screen's inputs read with today's relay, a head read and
 * then a names read, until a first-screen endpoint (the BFF) returns the
 * head with its names in one request. That change deletes this file: the
 * store's `FirstScreenSource.read` becomes the one request.
 */
export function todaysFirstScreenReads<Head>(store: {
  /** The relay can be read for the channel now. */
  canRead(channelId: string): boolean;
  /** The channel can still become readable: the roster has not ruled it out. */
  authorized(channelId: string): boolean;
  /** Listen for each change to the channel list. */
  onList(listener: () => void): () => void;
  /** Read the channel's head in the foreground. */
  head(channelId: string, signal: AbortSignal): Promise<Head>;
  /** Of the people `head`'s first screen shows, those not named yet. */
  unnamed(channelId: string, head: Head): readonly string[];
  /** Read those names in the foreground. */
  readNames(ids: readonly string[]): Promise<void>;
}) {
  /** Resolves once the roster confirms a channel that cannot be read yet:
   * an opening before the list loads, after a reload. */
  function readable(channelId: string, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (
          !signal.aborted &&
          !store.canRead(channelId) &&
          store.authorized(channelId)
        )
          return;
        stop();
        signal.removeEventListener("abort", check);
        if (store.canRead(channelId)) resolve();
        else
          reject(signal.reason ?? new DOMException("No access", "AbortError"));
      };
      const stop = store.onList(check);
      signal.addEventListener("abort", check, { once: true });
      check();
    });
  }
  return {
    /** An opening's own head read. Nothing else waits it out or replaces
     * it: a catch-up joins or follows it (see the store's `catchUp`), and
     * one cancelled from outside (an access change that left the channel
     * readable, a reader recovery) starts again once. */
    async head(channelId: string, signal: AbortSignal): Promise<Head> {
      for (let attempt = 0; ; attempt++) {
        if (!store.canRead(channelId)) await readable(channelId, signal);
        try {
          return await openTrace.cause(
            { purpose: "head", channel: channelId },
            () => store.head(channelId, signal),
          );
        } catch (error) {
          if (signal.aborted || readErrorKind(error) !== "cancelled" || attempt)
            throw error;
        }
      }
    },
    /** Read the names `head`'s first screen shows that are not known yet.
     * Never rejects. */
    names(channelId: string, head: Head): Promise<void> {
      const missing = store.unnamed(channelId, head);
      if (!missing.length) return Promise.resolve();
      return openTrace
        .cause({ purpose: "names", channel: channelId }, () =>
          store.readNames(missing),
        )
        .catch(() => {});
    },
  };
}
