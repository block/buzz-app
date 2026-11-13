import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AgentEventTemplate } from "../agents/native";
import { eventDto, type RelayEvent } from "../relay/events";

export type MoveAgentHost = {
  prepare(
    author: string,
    origin: string,
    event: AgentEventTemplate,
  ): Promise<RelayEvent>;
  publish(
    author: string,
    origin: string,
    event: RelayEvent,
  ): Promise<RelayEvent>;
};
/** Use the existing agent custody and authenticated publication path. */
export function nativeMoveAgentHost(): MoveAgentHost | undefined {
  if (!isTauri()) return;
  const args = (pubkey: string, origin: string, event: unknown) => ({
    pubkey,
    relay: origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:"),
    event,
  });
  return {
    prepare: async (author, origin, event) =>
      eventDto(
        await invoke("app_agent_prepare_dm_move", args(author, origin, event)),
      ),
    publish: async (author, origin, event) =>
      eventDto(
        await invoke("app_agent_publish_dm_move", args(author, origin, event)),
      ),
  };
}
