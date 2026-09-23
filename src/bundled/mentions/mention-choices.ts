import type { MentionRecipient } from "../../features/messages/mention-draft";
import type { Profile } from "../../features/relay/contracts";

/** Keep wire names recognizable by the sent-message binder; resolve only UI labels. */
export function mentionChoices(
  agents: readonly MentionRecipient[],
  members: readonly string[],
  profiles: ReadonlyMap<string, Profile>,
  resolveName: (pubkey: string, fallback: string) => string,
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
  return [...choices.values()].map((recipient) => ({
    recipient,
    label: resolveName(recipient.pubkey, recipient.name),
  }));
}
