import { knownAgentPubkeys } from "../../features/agents/known";
import type { MentionDraft } from "../../features/messages/mention-draft";
import type { RelaySession } from "../../features/relay/session";

/** Display evidence chooses an agent; the messages owner still authorizes exact p tags. */
export function channelSessionRecipients(
  session: RelaySession,
  channelId: string,
  draft: MentionDraft,
) {
  if (!draft.text.trim())
    throw new Error(
      "Write a prompt after /session and select an agent with @.",
    );
  const recipients = [...new Set(draft.recipients.map((item) => item.pubkey))];
  const known = knownAgentPubkeys(
    session.profiles.snapshot(),
    session.agentChoices.snapshot(),
  );
  const members = session.channels
    .list()
    .channels.find((item) => item.id === channelId)?.members;
  if (!recipients.some((key) => known.has(key) && members?.includes(key)))
    throw new Error(
      "Select at least one current channel agent with @ before sending. Typed names alone do not notify anyone.",
    );
  if (recipients.some((key) => !members?.includes(key)))
    throw new Error(
      "Every selected recipient must be a current channel member.",
    );
  return recipients;
}
