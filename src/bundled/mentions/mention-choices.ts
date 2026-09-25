import type { MentionRecipient } from "../../features/messages/mention-draft";
import type { Profile } from "../../features/relay/contracts";
import type { NamingIdentity } from "../../features/identity-names/policy";

/** Keep wire names recognizable by the sent-message binder; resolve only UI labels. */
export function mentionChoices(
  agents: readonly MentionRecipient[],
  members: readonly string[],
  profiles: ReadonlyMap<string, Profile>,
  resolveName: (
    pubkey: string,
    fallback: string,
    candidates?: readonly string[],
    displayFacts?: readonly NamingIdentity[],
  ) => string,
) {
  const choices = new Map(
    agents.map(({ pubkey, name }) => [pubkey, { pubkey, name }]),
  );
  for (const pubkey of members)
    choices.set(pubkey, {
      pubkey,
      name:
        profiles.get(pubkey)?.name ??
        choices.get(pubkey)?.name ??
        pubkey.slice(0, 12),
    });
  const candidates = [...choices.keys()];
  // Directory people may have no cached profile. Supply their names so namesakes
  // in this choice set are qualified; known names keep their own sources.
  const facts = agents
    .filter(
      ({ pubkey }) => !members.includes(pubkey) && !resolveName(pubkey, ""),
    )
    .map(({ pubkey, name }) => ({ pubkey, name }));
  return [...choices.values()].map((recipient) => ({
    recipient,
    label: resolveName(recipient.pubkey, recipient.name, candidates, facts),
  }));
}
