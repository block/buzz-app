import type { NameProvider } from "../../features/identity-names/service";
import type { AgentControl } from "../../features/agents/control";
import { relayOrigin } from "../../features/communities/destination";

function sameCommunity(left: string, right: string) {
  try {
    return relayOrigin(left) === relayOrigin(right);
  } catch {
    return false;
  }
}

/** Native configuration wins only in its community. Names never grant control. */
export function createAgentDirectory(
  control?: Pick<AgentControl, "snapshot" | "subscribe" | "refresh">,
): NameProvider {
  return {
    id: "agents",
    ...(control ? { subscribe: control.subscribe } : {}),
    activate(source) {
      void source.agentLibrary.refresh();
      void control?.refresh();
    },
    resolve(source, pubkey) {
      const key = pubkey.toLowerCase();
      const native = control?.snapshot();
      const relayUrl = source.relayUrl;
      const managed =
        relayUrl && native?.status === "ready"
          ? native.data?.agents.find(
              (agent) =>
                agent.pubkey.toLowerCase() === key &&
                sameCommunity(agent.relayUrl, relayUrl),
            )
          : undefined;
      if (managed?.name.trim()) return managed.name.trim();
      const library = source.agentLibrary.snapshot();
      if (library.status !== "ready") return undefined;
      return (
        library.identities
          .find((identity) => identity.pubkey.toLowerCase() === key)
          ?.name.trim() || undefined
      );
    },
  };
}

export const agentDirectory = createAgentDirectory();
