// Stop from the owner's other devices: the copy of the app that runs an agent
// hears the owner's stop requests to it, stops its turns there as Stop does
// here, and answers with a `control_result`.
import type { RelayEvent } from "../relay/events";
import type { CancelTurn, ControlResult } from "./agent-control";
import type { LocalAgentSource } from "./local-activity";

/** A control frame native code checked and decrypted: its agent's owner
 * asks the agent to stop. */
export type ControlRequest = Readonly<{
  eventId: string;
  agent: string;
  request: CancelTurn;
}>;
/** What this copy answers, for the request type it answers: it never needs
 * `ambiguous_target`, as either request names exactly what to stop. */
export type ControlAnswer = ControlResult &
  Readonly<{ status: "sent" | "no_active_turn" }>;

/** Acts on one control frame for the agents in `scope`: answers `sent` once
 * one of the agent's turns there has stopped, or `no_active_turn` when none
 * could be stopped. A frame native code refuses, or stops that all fail, get
 * no answer, so the sender's own wait tells the owner. */
export async function remoteStop(
  event: RelayEvent,
  scope: string,
  host: Readonly<{
    decode(event: RelayEvent): Promise<ControlRequest>;
    interrupt: NonNullable<LocalAgentSource["interruptConversation"]>;
    answer(answer: ControlAnswer): Promise<void>;
  }>,
): Promise<void> {
  const { agent, request } = await host.decode(event);
  const stops = host.interrupt({
    scope,
    agent,
    channelId: request.channelId,
    threadRootId:
      request.type === "cancel_thread_turn" ? request.threadRootId : undefined,
  });
  let status: ControlAnswer["status"] = "no_active_turn";
  if (stops.length) {
    await Promise.any(stops);
    status = "sent";
  }
  await host.answer({
    agent,
    type: request.type,
    channelId: request.channelId,
    requestId: request.requestId,
    status,
  });
}
