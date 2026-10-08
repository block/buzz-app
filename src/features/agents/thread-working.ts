import type { createAgentActivity } from "./activity";
import { requestWork } from "./request-work";

type Snapshot = ReturnType<
  ReturnType<typeof createAgentActivity>["queries"]["snapshot"]
>;

/** Use the same request state as message bubbles. Pulses remain useful for
 * unassociated work, but cannot revive a request with known lifecycle evidence. */
export function threadWorkingAgents(
  activity: Snapshot | undefined,
  typing: readonly string[],
  channelId: string,
  rootId: string,
): readonly string[] {
  if (activity?.status !== "listening") return typing;
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
      ...work.filter((entry) => entry.working).map((entry) => entry.agent),
      ...typing.filter((agent) => !known.has(agent)),
    ]),
  ];
}
