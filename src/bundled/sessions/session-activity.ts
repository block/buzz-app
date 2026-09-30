import {
  ACTIVITY_TRIGGER_LIMIT,
  type ActivityTurn,
} from "../../features/agents/activity";
import type { ChannelMessage } from "../../features/relay/contracts";

type Evidence = readonly Pick<
  ChannelMessage,
  "id" | "channelId" | "threadRootId" | "delivery"
>[];
export type MatchedSessionTurn = ActivityTurn & Readonly<{ rootId: string }>;

export type SessionActivityState = "working" | "unknown";
const key = /^[0-9a-f]{64}$/;
const ROOT_WALK_LIMIT = 32;

/** Owner-visible correlation only, never membership, participation or ordering.
 * Every trigger must resolve through retained same-channel messages to ONE real
 * root. Missing/ambiguous evidence is omitted, not fetched or guessed. */
export function matchedSessionTurns(
  rows: Evidence,
  turns: readonly ActivityTurn[],
): readonly MatchedSessionTurn[] {
  const messages = new Map<string, Evidence[number]>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    const id = `${row.channelId}/${row.id}`;
    if (
      row.delivery &&
      row.delivery !== "accepted" &&
      row.delivery !== "seen"
    ) {
      ambiguous.add(id);
      continue;
    }
    const previous = messages.get(id);
    if (previous && previous.threadRootId !== row.threadRootId)
      ambiguous.add(id);
    messages.set(id, row);
  }
  const resolved = new Map<string, string | undefined>();
  function root(channelId: string, id: string): string | undefined {
    const cacheKey = `${channelId}/${id}`;
    if (resolved.has(cacheKey)) return resolved.get(cacheKey);
    let current = id;
    const visited = new Set<string>();
    for (let depth = 0; depth < ROOT_WALK_LIMIT; depth++) {
      if (!key.test(current) || visited.has(current)) break;
      visited.add(current);
      const row = messages.get(`${channelId}/${current}`);
      if (!row || ambiguous.has(`${channelId}/${current}`)) break;
      if (row.threadRootId === undefined) {
        resolved.set(cacheKey, row.id);
        return row.id;
      }
      current = row.threadRootId;
    }
    resolved.set(cacheKey, undefined);
    return undefined;
  }
  const result: MatchedSessionTurn[] = [];
  for (const turn of turns) {
    if (
      !turn.channelId ||
      !key.test(turn.agent) ||
      !turn.turnId ||
      !turn.triggeringEventIds?.length ||
      turn.triggeringEventIds.length > ACTIVITY_TRIGGER_LIMIT
    )
      continue;
    let rootId: string | undefined;
    for (const id of turn.triggeringEventIds) {
      const candidate = root(turn.channelId, id);
      if (!candidate || (rootId && rootId !== candidate)) {
        rootId = undefined;
        break;
      }
      rootId = candidate;
    }
    if (!rootId) continue;
    result.push({ ...turn, rootId });
  }
  return result;
}

/** Existing row badges deliberately omit ended turns. Detail may retain their raw evidence. */
export function sessionActivity(
  rows: Evidence,
  turns: readonly ActivityTurn[],
): ReadonlyMap<string, SessionActivityState> {
  const result = new Map<string, SessionActivityState>();
  for (const turn of matchedSessionTurns(rows, turns)) {
    if (turn.state === "ended") continue;
    const scope = `${turn.channelId}/${turn.rootId}`;
    if (result.get(scope) !== "working") result.set(scope, turn.state);
  }
  return result;
}
