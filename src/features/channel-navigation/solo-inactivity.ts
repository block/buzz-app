import type { ChannelSummary } from "../relay/contracts";

/** Solo chats quiet this long fold into Inactive. */
export const SOLO_INACTIVE_AFTER = 72 * 60 * 60 * 1000;

/** Chats whose last message is older than the window, and when the next listed
 * chat crosses it. A chat with no known message stays listed. */
export function inactiveSoloChats(
  chats: readonly ChannelSummary[],
  exempt: (id: string) => boolean,
  now: number,
): { ids: ReadonlySet<string>; nextAt: number } {
  const ids = new Set<string>();
  let nextAt = Infinity;
  for (const chat of chats) {
    const last = chat.lastActivityAt;
    if (last === undefined || exempt(chat.id)) continue;
    const at = last * 1000 + SOLO_INACTIVE_AFTER;
    if (at <= now) ids.add(chat.id);
    else nextAt = Math.min(nextAt, at);
  }
  return { ids, nextAt };
}
