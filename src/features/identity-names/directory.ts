import type { NamingIdentity } from "./policy";
import type { NamingPolicy } from "./service";
import type { NameProvider } from "./service";
import type { AgentControl } from "../agents/control";
import { relayOrigin } from "../communities/destination";

function sameCommunity(left: string, right: string) {
  try {
    return relayOrigin(left) === relayOrigin(right);
  } catch {
    return false;
  }
}

/** Native configuration wins only in its community. Names never grant control. */
export function createNameProvider(
  policy: NamingPolicy,
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
    id: policy.id,
    ...(control ? { subscribe: control.subscribe } : {}),
    activate(source) {
      void control?.refresh();
      return source.agentLibrary.retain();
    },
    resolve(source, pubkey, candidates, displayFacts) {
      const key = pubkey.toLowerCase();
      const native = control?.snapshot();
      const relayUrl = source.relayUrl;
      const library = source.agentLibrary.snapshot();
      const profiles = source.profiles.snapshot();
      // Include the requested identity even for historical non-member references.
      const selection =
        candidates &&
        [
          ...new Set([...candidates, key].map((key) => key.toLowerCase())),
        ].sort();
      const inputs = [
        library,
        native,
        profiles,
        relayUrl,
        source.viewer,
        selection?.join(":"),
        displayFacts,
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
        const identities = new Map<string, NamingIdentity>(
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
        // View-local labels (authored draft text or cross-community management rows)
        // supplement display facts only; they never select recipients or grant control.
        for (const fact of displayFacts ?? []) {
          const key = fact.pubkey.toLowerCase();
          identities.set(key, { ...identities.get(key), ...fact, pubkey: key });
        }
        const resolved = policy.resolve(
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
    qualifier(source, pubkey, candidates, displayFacts) {
      this.resolve(source, pubkey, candidates, displayFacts);
      return cached?.suffixes.get(pubkey.toLowerCase());
    },
  };
}
