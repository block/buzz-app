import type { RelaySession } from "../../features/relay/session";
import type { ChannelMessage } from "../../features/relay/contracts";
import { requestActivity, requestActivityState } from "./request-activity";

type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
/** Shared thread evidence for the channel control, live tail and hover details.
 * Loaded hidden replies are valid trigger IDs, never proof of delivery or work.
 * Adapted from PR #406; retains ended records for inspection, not live status. */
export function threadActivity(
  snapshot: Snapshot,
  channelId: string,
  rootId: string,
  messages: readonly ChannelMessage[] = [],
  requestId?: string,
) {
  const ids = [
    rootId,
    ...messages
      .filter(
        (row) =>
          row.channelId === channelId &&
          (row.id === rootId || row.threadRootId === rootId),
      )
      .map((row) => row.id),
    ...(requestId ? [requestId] : []),
  ];
  const typing =
    snapshot.status === "listening"
      ? snapshot.typing.filter(
          (entry) =>
            entry.channelId === channelId && entry.threadRootId === rootId,
        )
      : [];
  const agents = new Set([
    ...snapshot.turns
      .filter((turn) => turn.channelId === channelId)
      .map((turn) => turn.agent),
    ...typing.map((entry) => entry.agent),
    ...snapshot.records
      .filter((record) => record.channelIds.includes(channelId))
      .map((record) => record.agent),
  ]);
  return [...agents]
    .sort()
    .map((agent) => {
      const selected = requestActivity(snapshot.records, agent, channelId, ids);
      const turns = snapshot.turns.filter(
        (turn) =>
          turn.agent === agent &&
          turn.channelId === channelId &&
          selected.turnIds.has(turn.turnId),
      );
      const terminal = Math.max(
        -Infinity,
        ...turns
          .filter((turn) => turn.state === "ended")
          .map((turn) => turn.timestamp),
      );
      const typed = typing.some(
        (entry) => entry.agent === agent && entry.timestamp > terminal,
      );
      const state = requestActivityState(selected, turns, snapshot.trimmed);
      const working =
        snapshot.status === "listening" && (state === "working" || typed);
      return {
        agent,
        selected,
        turns,
        working,
        state: working ? ("working" as const) : state,
      };
    })
    .filter((entry) => entry.selected.turnIds.size > 0 || entry.working);
}
