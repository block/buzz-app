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

/** Shared profiles in the full snapshot, including hidden rows, need suffixes. */
export function identitySuffixes(identities: AgentLibrary["identities"]) {
  const profiles = new Map<string, Set<string>>();
  for (const row of identities) {
    if (!row.definitionId) continue;
    const keys = profiles.get(row.definitionId) ?? new Set<string>();
    keys.add(row.pubkey.toLowerCase());
    profiles.set(row.definitionId, keys);
  }
  const keys = [
    ...new Set(
      [...profiles.values()]
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
const suffixCache = new WeakMap<
  AgentLibrary["identities"],
  Map<string, string>
>();

/** Native configuration wins only in its community. Names never grant control. */
export function createAgentDirectory(
  control?: Pick<AgentControl, "snapshot" | "subscribe" | "refresh">,
): NameProvider {
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
      const managed =
        relayUrl && native?.status === "ready"
          ? native.data?.agents.find(
              (agent) =>
                agent.pubkey.toLowerCase() === key &&
                sameCommunity(agent.relayUrl, relayUrl),
            )
          : undefined;
      const library = source.agentLibrary.snapshot();
      const identity =
        library.status === "ready"
          ? library.identities.find((row) => row.pubkey.toLowerCase() === key)
          : undefined;
      const base = managed?.name.trim() || identity?.name.trim();
      if (!identity) return base || undefined;
      let suffixes = suffixCache.get(library.identities);
      if (!suffixes) {
        suffixes = identitySuffixes(library.identities);
        suffixCache.set(library.identities, suffixes);
      }
      const name = base || source.profiles.snapshot().get(key)?.name || "Agent";
      const suffix = suffixes.get(key);
      return suffix ? `${name} ${suffix}` : name;
    },
  };
}

export const agentDirectory = createAgentDirectory();
