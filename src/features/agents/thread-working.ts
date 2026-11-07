import { localActivity } from "./local-activity";
import type { createAgentActivity } from "./activity";
import { requestWork } from "./request-work";

type Snapshot = ReturnType<
  ReturnType<typeof createAgentActivity>["queries"]["snapshot"]
>;

/** Use the same request state as the conversation's end indicator. Pulses
 * remain useful for unassociated work, but cannot revive a request with known
 * lifecycle evidence.
 *
 * Until `threadExists` (the root has replies), a top-level request is its own
 * root: work that names it is the channel's, shown at the channel's end, not
 * here. Only explicit thread evidence counts then: typing in the thread, or
 * local work whose request is in it. */
export function threadWorkingAgents(
  activity: Snapshot | undefined,
  typing: readonly string[],
  channelId: string,
  rootId: string,
  threadExists = true,
): readonly string[] {
  const local = localActivity(activity, channelId, rootId);
  const activeLocal = (activity?.local ?? [])
    .filter(
      (row) =>
        row.channelId === channelId &&
        row.threadRootId === rootId &&
        (threadExists || row.thread) &&
        (row.state === "waiting" || row.state === "working"),
    )
    .map((row) => row.agent);
  const untrackedTyping = typing.filter((agent) => !local.has(agent));
  if (activity?.status !== "listening" || !threadExists)
    return [...new Set([...untrackedTyping, ...activeLocal])];
  const linked = activity.turns.filter(
    (turn) =>
      turn.channelId === channelId &&
      turn.requests?.some((request) => request.threadRootId === rootId),
  );
  const requests = [
    rootId,
    ...linked.flatMap(
      (turn) =>
        turn.requests
          ?.filter((request) => request.threadRootId === rootId)
          .map((request) => request.messageId) ?? [],
    ),
  ];
  const work = requestWork(activity, channelId, requests);
  const known = new Set([
    ...linked.map((turn) => turn.agent),
    ...work.map((entry) => entry.agent),
  ]);
  return [
    ...new Set([
      ...activeLocal,
      ...work
        .filter((entry) => !local.has(entry.agent) && entry.working)
        .map((entry) => entry.agent),
      ...untrackedTyping.filter((agent) => !known.has(agent)),
    ]),
  ];
}
