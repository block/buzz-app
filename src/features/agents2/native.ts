import { invoke, isTauri } from "@tauri-apps/api/core";
import type { RelayEvent } from "../relay/events";

/** A plugin agent's identity as native custody reports it; never the key. */
export type AgentIdentity = Readonly<{
  pubkey: string;
  /** The canonical `wss://` community origin it was created for. */
  relay: string;
  owner: string;
}>;
export type AgentEventTemplate = Readonly<{
  kind: number;
  content: string;
  tags?: readonly (readonly string[])[];
}>;
export type AgentsNative = {
  list(): Promise<readonly AgentIdentity[]>;
  prepare(destination: string, owner: string): Promise<string>;
  /** The signed-in owner's NIP-OA attestation for the pending key only. */
  authorize(pubkey: string): Promise<string[]>;
  commit(pubkey: string, auth: readonly string[]): Promise<AgentIdentity>;
  remove(pubkey: string): Promise<void>;
  /** Signs one event as the agent (kinds 0, 5, 7, 9, 40003 only) with its owner
   * attestation and posts it to the agent's community. */
  publish(pubkey: string, event: AgentEventTemplate): Promise<RelayEvent>;
};

export const nativeAgents = (): AgentsNative | undefined =>
  isTauri()
    ? {
        list: () => invoke("app_agent_list"),
        prepare: (destination, owner) =>
          invoke("app_agent_create_prepare", { destination, owner }),
        authorize: (pubkey) => invoke("app_agent_create_authorize", { pubkey }),
        commit: (pubkey, auth) =>
          invoke("app_agent_create_commit", { pubkey, auth }),
        remove: (pubkey) => invoke("app_agent_delete", { pubkey }),
        publish: (pubkey, event) =>
          invoke("app_agent_publish", {
            pubkey,
            event: {
              kind: event.kind,
              content: event.content,
              tags: event.tags ?? [],
            },
          }),
      }
    : undefined;
