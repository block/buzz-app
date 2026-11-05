// The names a turn's prompt shows beside each message's pubkey.
import type { AgentReads } from "../agents/reads";
import type { EventData } from "../relay/events";

/** How long a turn waits for profiles before naming whom it can. */
export const AUTHOR_NAMES_TIMEOUT_MS = 2_000;

/** Reads the profiles of these messages' authors, for at most
 * `AUTHOR_NAMES_TIMEOUT_MS`, and gives each author's taggable name once
 * known. A turn without the reads names no one. */
export async function authorNames(
  reads: Pick<AgentReads, "profiles" | "author"> | undefined,
  messages: readonly Pick<EventData, "pubkey">[],
): Promise<(pubkey: string) => string | undefined> {
  const author = reads?.author?.bind(reads);
  if (!reads || !author) return () => undefined;
  const pubkeys = [...new Set(messages.map((message) => message.pubkey))];
  if (pubkeys.length) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      reads.profiles(pubkeys).catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, AUTHOR_NAMES_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
  return author;
}
