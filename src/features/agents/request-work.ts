import type { RelaySession } from "../relay/session";
import { requestActivity, requestActivityState } from "./request-activity";

type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
/** Only explicit triggering IDs associate work with a message. Typing is not
 * message evidence, and a sibling request must never inherit the same bubble. */
export function requestWork(
  snapshot: Snapshot,
  channelId: string,
  messageId: string | readonly string[],
) {
  const agents = new Set(
    snapshot.records
      .filter((record) => record.channelIds.includes(channelId))
      .map((record) => record.agent),
  );
  return [...agents].sort().flatMap((agent) => {
    const selected = requestActivity(
      snapshot.records,
      agent,
      channelId,
      messageId,
    );
    if (!selected.turnIds.size) return [];
    const turns = snapshot.turns.filter(
      (turn) =>
        turn.agent === agent &&
        turn.channelId === channelId &&
        selected.turnIds.has(turn.turnId),
    );
    const state = requestActivityState(selected, turns, snapshot.trimmed);
    return [
      {
        agent,
        state,
        selected,
        turns,
        working: snapshot.status === "listening" && state === "working",
      },
    ];
  });
}
