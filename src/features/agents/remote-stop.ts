// Stop from the owner's other devices: the copy of the app that runs an agent
// hears the owner's `cancel_turn` control frames to it, stops its turns in that
// conversation as Stop does here, and answers with a `control_result`.
import type { RelayEvent } from "../relay/events";
import type { LocalAgentSource } from "./local-activity";

/** A `cancel_turn` request native code checked and decrypted. */
export type ControlRequest = Readonly<{
  eventId: string;
  agent: string;
  channelId: string;
  /** Absent for the whole channel's conversation. */
  threadRootId?: string;
  requestId: string;
}>;
export type ControlAnswer = Readonly<{
  channelId: string;
  requestId: string;
  status: "sent" | "no_active_turn";
}>;

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
    answer(agent: string, answer: ControlAnswer): Promise<void>;
  }>,
): Promise<void> {
  const request = await host.decode(event);
  const stops = host.interrupt({
    scope,
    agent: request.agent,
    channelId: request.channelId,
    threadRootId: request.threadRootId,
  });
  let status: ControlAnswer["status"] = "no_active_turn";
  if (stops.length) {
    await Promise.any(stops);
    status = "sent";
  }
  await host.answer(request.agent, {
    channelId: request.channelId,
    requestId: request.requestId,
    status,
  });
}
