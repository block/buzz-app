import type { EventData } from "./events.ts";

export const SOLO_FORK_EXTENSION = "buzz-solo-fork-v1";
export type SoloFork = Readonly<{ channelId: string; messageId: string }>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nil = "00000000-0000-0000-0000-000000000000";

/** Parse create-only ancestry, or its relay-signed metadata echo. Malformed is not ordinary. */
export function soloFork(event: Pick<EventData, "tags">): SoloFork | undefined {
  const tags = event.tags.filter(([name]) => name === "forked_from");
  if (!tags.length) return;
  const pointer = tags[0];
  const channelId = pointer?.[1];
  const messageId = pointer?.[2];
  if (
    tags.length !== 1 ||
    !pointer ||
    pointer.length !== 3 ||
    !channelId ||
    !uuid.test(channelId) ||
    channelId === nil ||
    !messageId ||
    !/^[0-9a-f]{64}$/.test(messageId)
  )
    throw new Error("The Solo fork has invalid source metadata.");
  return { channelId, messageId };
}

/** Host create admission: ancestry is valid only on a distinct private Solo stream. */
export function validSoloForkCreate(tags: string[][]): boolean {
  try {
    const fork = soloFork({ tags });
    return (
      !fork ||
      (fork.channelId !== tags[0]?.[1] &&
        tags[2]?.[1] === "private" &&
        tags[3]?.[1] === "stream" &&
        tags.some(
          (tag) => tag.length === 2 && tag[0] === "t" && tag[1] === "buzz.solo",
        ))
    );
  } catch {
    return false;
  }
}
