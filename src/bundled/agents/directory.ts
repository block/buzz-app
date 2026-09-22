import { npubEncode } from "nostr-tools/nip19";
import type { AgentLibrary } from "../../features/agents/library";
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

/** Equal display names in the full snapshot, including hidden rows, need suffixes. */
export function identitySuffixes(identities: AgentLibrary["identities"]) {
  const names = new Map<string, Set<string>>();
  for (const row of identities) {
    const name = row.name.trim();
    const keys = names.get(name) ?? new Set<string>();
    keys.add(row.pubkey.toLowerCase());
    names.set(name, keys);
  }
  const keys = [
    ...new Set(
      [...names.values()]
        .filter((group) => group.size > 1)
        .flatMap((group) => [...group]),
    ),
  ];
  const result = new Map<string, string>();
  const groups = new Map<string, { key: string; npub: string }[]>();
  for (const key of keys) {
    const npub = npubEncode(key);
    const suffix = npub.slice(-4);
    const group = groups.get(suffix) ?? [];
    group.push({ key, npub });
    groups.set(suffix, group);
  }
  for (const group of groups.values()) {
    let length = 4;
    while (
      length < 63 &&
      new Set(group.map(({ npub }) => npub.slice(-length))).size < group.length
    )
      length++;
    for (const { key, npub } of group) {
      result.set(key, npub.slice(-length));
    }
  }
  return result;
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
    resolve(source, pubkey) {
      const key = pubkey.toLowerCase();
      const native = control?.snapshot();
      const relayUrl = source.relayUrl;
      const library = source.agentLibrary.snapshot();
      const profiles = source.profiles.snapshot();
      const inputs = [library, native, profiles, relayUrl];
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
        const suffixes = identitySuffixes(
          [...names].map(([pubkey, name]) => ({ pubkey, name })),
        );
        for (const [key, suffix] of suffixes) {
          names.set(key, `${names.get(key)} · ${suffix}`);
        }
        cached = { inputs, names, suffixes };
      }
      return cached.names.get(key);
    },
    qualifier(source, pubkey) {
      this.resolve(source, pubkey);
      return cached?.suffixes.get(pubkey.toLowerCase());
    },
  };
}

export const agentDirectory = createAgentDirectory();
