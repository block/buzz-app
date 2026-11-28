// Stop from the owner's other devices: the copy of the app that runs an agent
// hears the owner's stop requests to it, stops its turns there as Stop does
// here, and answers with a `control_result`.
import type { RelayEvent } from "../relay/events";
import type { CancelTurn, ControlResult } from "./agent-control";
import type { LocalWork } from "./local-activity";

/** A control frame native code checked and decrypted: its agent's owner
 * asks the agent to stop. */
export type ControlRequest = Readonly<{
  eventId: string;
  agent: string;
  request: CancelTurn;
}>;
/** What this copy answers; only a `cancel_turn` can be `ambiguous_target`. */
export type ControlAnswer = ControlResult;

/** Where a turn runs: its thread, or the channel's top level. */
const placement = (work: Pick<LocalWork, "thread" | "threadRootId">) =>
  work.thread ? work.threadRootId : "";

/** Acts on one control frame for the agents in `scope`. A thread stop stops
 * the agent's turns placed in that thread. A channel stop stops its turns in
 * the channel when they all run in one place, and is `ambiguous_target`, with
 * nothing stopped, when they run in several. Answers `sent` once one turn has
 * stopped, or `no_active_turn` when none could be stopped. A frame native
 * code refuses, or stops that all fail, get no answer, so the sender's own
 * wait tells the owner. */
export async function remoteStop(
  event: RelayEvent,
  scope: string,
  host: Readonly<{
    decode(event: RelayEvent): Promise<ControlRequest>;
    work(): readonly LocalWork[];
    interrupt(work: LocalWork): Promise<void>;
    answer(answer: ControlAnswer): Promise<void>;
  }>,
): Promise<void> {
  const { agent, request } = await host.decode(event);
  const targets = host
    .work()
    .filter(
      (work) =>
        work.stoppable &&
        work.scope === scope &&
        work.agent === agent &&
        work.channelId === request.channelId &&
        (request.type === "cancel_turn" ||
          placement(work) === request.threadRootId),
    );
  let status: ControlAnswer["status"] = "no_active_turn";
  if (new Set(targets.map(placement)).size > 1) status = "ambiguous_target";
  else if (targets.length) {
    await Promise.any(targets.map((work) => host.interrupt(work)));
    status = "sent";
  }
  await host.answer({
    agent,
    channelId: request.channelId,
    type: request.type,
    requestId: request.requestId,
    status,
  });
}
