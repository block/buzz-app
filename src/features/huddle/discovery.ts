import type { EventData } from "../relay/events";
import type { RelaySession } from "../relay/session";
import { huddleLifecycleBody, huddleRoom } from "./lifecycle";

export type HuddleRoom = Readonly<{
  id: string;
  creator: string;
  startedAt: number;
  root?: string;
}>;
/** Discovery is advisory; the audio relay rechecks creator linkage and membership. */
export function recentHuddles(
  events: readonly EventData[],
  parent: string,
  authority: string | undefined,
  now = Date.now() / 1000,
): HuddleRoom[] {
  const scoped = events.filter((e) =>
    e.tags.some((t) => t[0] === "h" && t[1] === parent),
  );
  const starts = new Map<string, HuddleRoom>();
  for (const event of scoped) {
    const id = huddleRoom(event);
    if (event.kind !== 48100 || !id || id === parent) continue;
    const previous = starts.get(id);
    const candidate = huddleLifecycleBody(event)?.thread_root;
    const root =
      typeof candidate === "string" && /^[0-9a-f]{64}$/.test(candidate)
        ? candidate
        : undefined;
    // The initial creator's announcement owns this advisory room identity.
    if (!previous || event.created_at < previous.startedAt)
      starts.set(id, {
        id,
        creator: event.pubkey,
        startedAt: event.created_at,
        ...(root && { root }),
      });
  }
  for (const event of scoped) {
    const id = huddleRoom(event);
    const start = id ? starts.get(id) : undefined;
    if (
      event.kind === 48103 &&
      start &&
      event.created_at >= start.startedAt &&
      (event.pubkey === start.creator || event.pubkey === authority)
    )
      starts.delete(start.id);
  }
  return [...starts.values()]
    .filter((room) => room.startedAt <= now && room.startedAt + 3600 > now)
    .sort((a, b) => b.startedAt - a.startedAt);
}
export async function discoverHuddles(
  session: RelaySession,
  parent: string,
  signal: AbortSignal,
) {
  const events = await session.read(
    [
      { kinds: [48100], "#h": [parent], limit: 30 },
      { kinds: [48103], "#h": [parent], limit: 100 },
    ],
    { signal, priority: "foreground", fresh: true },
  );
  return recentHuddles(events, parent, session.relayAuthor);
}
