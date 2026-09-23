import { resolveIdentityNames } from "../../features/identity-names/policy";
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
  let cached:
    | {
        inputs: readonly unknown[];
        names: Map<string, string>;
        suffixes: Map<string, string>;
      }
    | undefined;
  return {
    id: "agents",
    ...(control ? { subscribe: control.subscribe } : {}),
    activate(source) {
      void control?.refresh();
      return source.agentLibrary.retain();
    },
    resolve(source, pubkey, candidates) {
      const key = pubkey.toLowerCase();
      const native = control?.snapshot();
      const relayUrl = source.relayUrl;
      const library = source.agentLibrary.snapshot();
      const profiles = source.profiles.snapshot();
      // Include the requested identity even for historical non-member references.
      const selection = candidates && [...new Set([...candidates, key])].sort();
      const inputs = [
        library,
        native,
        profiles,
        relayUrl,
        source.viewer,
        selection?.join(":"),
      ];
      if (
        !cached ||
        inputs.some((input, index) => input !== cached?.inputs[index])
      ) {
        const names = new Map<string, string>();
        if (library.status === "ready") {
          for (const row of library.identities) {
            const key = row.pubkey.toLowerCase();
            if (!names.has(key))
              names.set(
                key,
                row.name.trim() || profiles.get(key)?.name.trim() || "Agent",
              );
          }
        }
        if (relayUrl && native?.status === "ready") {
          const seen = new Set<string>();
          for (const agent of native.data?.agents ?? []) {
            const key = agent.pubkey.toLowerCase();
            if (seen.has(key) || !sameCommunity(agent.relayUrl, relayUrl))
              continue;
            seen.add(key);
            const name = agent.name.trim();
            if (name) names.set(key, name);
          }
        }
        const identities = new Map(
          [...profiles].map(([pubkey, profile]) => [
            pubkey,
            { pubkey, ...profile },
          ]),
        );
        for (const [pubkey, name] of names) {
          identities.set(pubkey, {
            ...profiles.get(pubkey),
            pubkey,
            name,
            isAgent: true,
          });
        }
        const resolved = resolveIdentityNames(
          [...identities.values()],
          source.viewer,
          selection,
        );
        const suffixes = new Map<string, string>();
        for (const [key, label] of resolved) {
          names.set(key, label.name);
          if (label.qualifier) suffixes.set(key, label.qualifier);
        }
        cached = { inputs, names, suffixes };
      }
      return cached.names.get(key);
    },
    qualifier(source, pubkey, candidates) {
      this.resolve(source, pubkey, candidates);
      return cached?.suffixes.get(pubkey.toLowerCase());
    },
  };
}

export const agentDirectory = createAgentDirectory();
